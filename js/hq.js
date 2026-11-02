import { DESKS, DESK_BY_ID, routeBrief, runPlaybook } from "./desks.js";
import { loadState, saveState, resetState, newId } from "./store.js";
import { proposalFromForgeBody } from "./evolution.js";
import {
  AGENT_DESK_IDS,
  defaultAgentDeskConfig,
  deskUsesLiveAgent,
} from "./agent-desks.js";
import {
  buildForgeBriefFromJob,
  shouldOfferRecursiveCycle,
} from "./recursive-improve.js";
import { validateSourceInput } from "./linked-sources.js";

const STEP_MS = 420;
const MAURITIUS = "Indian/Mauritius";

const state = loadState();
const els = {};

function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatWhen(ts) {
  const date = new Date(ts);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MAURITIUS,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function mastClock() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MAURITIUS,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function persist() {
  saveState(state);
}

function log(text) {
  state.log.unshift({ id: newId("log"), at: Date.now(), text });
  state.log = state.log.slice(0, 40);
}

function filteredJobs() {
  const jobs = [...state.jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.selectedDesk === "all") return jobs;
  return jobs.filter((job) => job.deskId === state.selectedDesk);
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedJobId) ?? null;
}

function counts() {
  const open = (deskId) =>
    state.jobs.filter(
      (job) => job.deskId === deskId && (job.status === "queued" || job.status === "working" || job.status === "filed" || job.status === "returned"),
    ).length;
  return Object.fromEntries(DESKS.map((desk) => [desk.id, open(desk.id)]));
}

function liveRoute() {
  const brief = els.brief.value;
  const override = els.deskSelect.value;
  if (override !== "auto") return override;
  return routeBrief(brief);
}

function renderMast() {
  els.clock.textContent = `${mastClock()} Mauritius`;
  els.orchestrator.textContent = state.company.orchestrator;
  els.companyName.textContent = state.company.name;
}

function renderDesks() {
  const tally = counts();
  const items = [
    {
      id: "all",
      code: "YOU",
      name: "Orchestrator",
      job: "Judgment",
      duty: "Issue briefs. Accept, return, or kill files. Do not take the chair.",
    },
    ...DESKS,
  ];
  els.deskList.innerHTML = items
    .map((desk) => {
      const active = desk.id === state.selectedDesk ? " is-active" : "";
      const n = desk.id === "all" ? state.jobs.length : tally[desk.id];
      const count = desk.id === "all" ? `${n} files` : n ? `${n} open` : "idle";
      const recur =
        desk.id !== "all" && state.agents?.[desk.id]?.recursive !== false
          ? " · self-improve"
          : "";
      const live =
        desk.id !== "all" && state.agents?.[desk.id]?.mode === "agent" ? " · live" : "";
      return `<button class="desk${active}" type="button" data-desk="${esc(desk.id)}" aria-pressed="${desk.id === state.selectedDesk}">
        <span class="desk-code">${esc(desk.code)}</span>
        <span class="desk-copy">
          <span class="desk-name">${esc(desk.name)}</span>
          <span class="desk-job">${esc(desk.job)} · ${esc(count)}${live}${recur}</span>
        </span>
      </button>`;
    })
    .join("");

  els.mission.value = state.company.mission;
  els.orchestratorInput.value = state.company.orchestrator;
  renderAgentSettings();
  renderAgentPoolStatus();
  renderLinkedSources();
}

let agentPoolHealth = null;
let linkedSourceManifest = null;

async function persistLinkedSourcesToServer() {
  try {
    const res = await fetch("/api/linked-sources", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: state.linkedSources }),
    });
    if (!res.ok) return false;
    const payload = await res.json();
    if (payload.config?.sources) state.linkedSources = payload.config.sources;
    return true;
  } catch {
    return false;
  }
}

async function pullLinkedSourcesFromServer() {
  try {
    const res = await fetch("/api/linked-sources");
    if (!res.ok) return;
    const payload = await res.json();
    if (Array.isArray(payload.config?.sources) && payload.config.sources.length) {
      state.linkedSources = payload.config.sources;
      persist();
    }
    linkedSourceManifest = payload.manifest ?? null;
  } catch {
    /* static HQ */
  }
}

async function syncLinkedSourcesNow() {
  const saved = await persistLinkedSourcesToServer();
  if (!saved) {
    log("Link sites while running npm run dev to enable 24/7 fetch.");
    return;
  }
  try {
    const res = await fetch("/api/linked-sources/sync", { method: "POST" });
    const payload = await res.json();
    if (payload.ok) {
      linkedSourceManifest = payload.manifest;
      log(`Synced ${payload.manifest?.count ?? 0} linked site(s) for Scout.`);
    } else {
      log(`Source sync failed: ${payload.error ?? "unknown"}`);
    }
  } catch {
    log("Source sync failed — is npm run dev running?");
  }
  renderLinkedSources();
}

function renderLinkedSources() {
  const list = document.getElementById("linked-source-list");
  const meta = document.getElementById("linked-source-meta");
  if (!list) return;
  const sources = state.linkedSources ?? [];
  if (!sources.length) {
    list.innerHTML = `<li class="muted">No sites linked yet.</li>`;
  } else {
    list.innerHTML = sources
      .map(
        (s) => `<li>
          <span><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label ?? s.url)}</a></span>
          <button type="button" class="btn btn-quiet" data-unlink="${esc(s.id)}">Remove</button>
        </li>`,
      )
      .join("");
  }
  if (meta) {
    const synced = linkedSourceManifest?.syncedAt;
    meta.textContent = synced
      ? `Last sync (Mauritius): ${formatWhen(new Date(synced).getTime())} · ${linkedSourceManifest.count ?? sources.length} source(s)`
      : sources.length
        ? "Not synced yet — use Sync now (requires npm run dev)."
        : "";
  }
}

async function fetchAgentPoolHealth() {
  try {
    const res = await fetch("/api/agents/health");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderAgentPoolStatus() {
  const node = document.getElementById("agent-pool-status");
  if (!node) return;
  const h = agentPoolHealth;
  if (!h) {
    node.dataset.state = "offline";
    node.textContent =
      "Static HQ — run npm run dev for the 24/7 agent pool and patrol schedules locally.";
    return;
  }
  if (h.poolReady) {
    node.dataset.state = "ready";
    const n = Array.isArray(h.agents) ? h.agents.length : h.desks?.length ?? 0;
    node.textContent = `Agent pool ready (${n} workers). Patrol schedule: ${h.patrolSchedule ?? "patrol"} on hosted deploy.`;
    return;
  }
  node.dataset.state = h.credentialed ? "warn" : "offline";
  node.textContent = h.note ?? "Agent pool not ready.";
}

function renderAgentSettings() {
  if (!els.agentSettings) return;
  els.agentSettings.innerHTML = AGENT_DESK_IDS.map((id) => {
    const desk = DESK_BY_ID[id];
    const cfg = state.agents?.[id] ?? defaultAgentDeskConfig();
    return `<fieldset class="agent-desk-config">
      <legend>${esc(desk?.name ?? id)}</legend>
      <label>Run mode
        <select data-agent-mode="${esc(id)}">
          <option value="playbook" ${cfg.mode !== "agent" ? "selected" : ""}>Playbook</option>
          <option value="agent" ${cfg.mode === "agent" ? "selected" : ""}>Live agent</option>
        </select>
      </label>
      <label class="agent-recursive">
        <input type="checkbox" data-agent-recursive="${esc(id)}" ${cfg.recursive !== false ? "checked" : ""}>
        Recursive self-improvement
      </label>
    </fieldset>`;
  }).join("");
}

function renderRouteHint() {
  const id = liveRoute();
  const desk = DESK_BY_ID[id];
  if (!desk) {
    els.routeHint.textContent = "";
    return;
  }
  let hint = `Will file to ${desk.name} — ${desk.job.toLowerCase()}. ${desk.duty}`;
  if (deskUsesLiveAgent(state.agents, id)) {
    hint += " Live 24/7 agent (hosted deploy or npm run dev + Cursor credential).";
  } else {
    hint += " Playbook fallback (desk set to offline mode).";
  }
  if (id === "forge") {
    hint += " Files an evolution proposal — accept applies change to desks/agents.";
  }
  const applied = state.evolution?.applied?.length ?? 0;
  if (applied) hint += ` ${applied} accepted evolution change${applied === 1 ? "" : "s"} on record.`;
  els.routeHint.textContent = hint;
}

function statusLabel(status) {
  return status;
}

function renderBoard() {
  const jobs = filteredJobs();
  if (!jobs.length) {
    els.board.innerHTML = `<p class="empty">No jobs on this desk. Issue a brief.</p>`;
    return;
  }
  els.board.innerHTML = jobs
    .map((job) => {
      const desk = DESK_BY_ID[job.deskId];
      const active = job.id === state.selectedJobId ? " is-active" : "";
      const step = job.steps?.find((s) => !s.done);
      const meta =
        job.status === "working" && step
          ? `${step.label}`
          : `${formatWhen(job.updatedAt)} Mauritius`;
      const proposal = job.kind === "proposal" ? " is-proposal" : "";
      return `<button class="job${active} is-${esc(job.status)}${proposal}" type="button" data-job="${esc(job.id)}">
        <span class="job-code">${esc(desk?.code ?? "???")}</span>
        <span class="job-body">
          <span class="job-title">${esc(job.title || job.brief)}${job.kind === "proposal" ? " · proposal" : ""}</span>
          <span class="job-meta">${esc(meta)}</span>
        </span>
        <span class="job-status">${esc(statusLabel(job.status))}</span>
      </button>`;
    })
    .join("");
}

function renderFile() {
  const job = selectedJob();
  const pane = els.filePane;
  const stamp = job ? `${job.id}:${job.status}` : "";
  if (els.file.getAttribute("data-stamp") !== stamp) {
    pane.scrollTop = 0;
    els.file.setAttribute("data-stamp", stamp);
  }
  if (!job) {
    els.file.innerHTML = `<p class="empty">Select a file on the floor.</p>`;
    return;
  }
  const desk = DESK_BY_ID[job.deskId];
  const working = job.status === "working";
  const filed = job.status === "filed" || job.status === "returned";
  const accepted = job.status === "accepted";
  const steps = (job.steps ?? [])
    .map(
      (step) =>
        `<li class="${step.done ? "is-done" : ""}">${esc(step.label)}</li>`,
    )
    .join("");
  const acceptLabel =
    job.kind === "proposal" ? "Accept & apply evolution" : "Accept to record";
  const recursiveBtn = shouldOfferRecursiveCycle(state.agents, job.deskId, job)
    ? `<button type="button" class="btn" data-act="recursive">Start self-improvement cycle (Forge)</button>`
    : "";
  const actions = filed
    ? `<div class="file-actions">
        <button type="button" class="btn btn-primary" data-act="accept">${esc(acceptLabel)}</button>
        <button type="button" class="btn" data-act="return">Return to desk</button>
        <button type="button" class="btn btn-danger" data-act="kill">Kill</button>
        ${recursiveBtn}
      </div>
      <label class="return-notes">Return notes
        <textarea id="return-notes" rows="3" placeholder="What the desk must fix."></textarea>
      </label>`
    : accepted
      ? `<p class="file-seal">${job.kind === "proposal" ? "Evolution applied. Desks and Scout agent pick this up on the next file." : "On the company record. The desk is done."}</p>`
      : job.status === "killed"
        ? `<p class="file-seal">Killed. This job does not return.</p>`
        : "";

  els.file.innerHTML = `
    <header class="file-head">
      <p class="file-kicker">${esc(desk?.code ?? "")} · ${esc(desk?.name ?? "")} · ${esc(job.status)}</p>
      <h2>${esc(job.title)}</h2>
      <p class="file-brief">Brief: ${esc(job.brief)}</p>
    </header>
    ${working || job.steps?.length ? `<ol class="steps">${steps}</ol>` : ""}
    ${actions}
    <article class="file-body">${renderBody(job.body)}</article>
  `;
}

function renderBody(body) {
  const blocks = String(body ?? "").split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines[0].startsWith("# ")) {
        return `<h3>${esc(lines[0].slice(2))}</h3>${
          lines.length > 1 ? `<p>${esc(lines.slice(1).join(" "))}</p>` : ""
        }`;
      }
      const list = lines.every((line) => /^[-*]\s/.test(line) || /^\d+\.\s/.test(line));
      if (list) {
        const items = lines
          .map((line) => `<li>${esc(line.replace(/^[-*]\s/, "").replace(/^\d+\.\s/, ""))}</li>`)
          .join("");
        const ordered = /^\d+\.\s/.test(lines[0]);
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      const title = lines[0];
      const rest = lines.slice(1).join("\n");
      if (rest && title.length < 48 && !title.endsWith(".")) {
        return `<h4>${esc(title)}</h4><p>${esc(rest).replaceAll("\n", "<br>")}</p>`;
      }
      return `<p>${esc(block).replaceAll("\n", "<br>")}</p>`;
    })
    .join("");
}

function renderLog() {
  els.log.innerHTML = state.log
    .slice(0, 8)
    .map((entry) => `<li><time>${esc(formatWhen(entry.at))}</time> ${esc(entry.text)}</li>`)
    .join("");
}

function render() {
  renderMast();
  renderDesks();
  renderRouteHint();
  renderBoard();
  renderFile();
  renderLog();
}

function issueBrief(event) {
  event.preventDefault();
  const brief = els.brief.value.trim();
  if (!brief) {
    els.brief.focus();
    return;
  }
  const deskId = liveRoute();
  if (deskUsesLiveAgent(state.agents, deskId)) {
    void issueAgentBrief(brief, deskId);
    els.brief.value = "";
    return;
  }
  const playbook = runPlaybook(deskId, brief, state.company, state.evolution);
  const job = {
    id: newId("job"),
    deskId,
    brief,
    kind: playbook.kind ?? "work",
    status: "queued",
    title: playbook.title,
    body: "",
    steps: playbook.steps.map((step) => ({ ...step, done: false })),
    notes: "",
    seed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _file: playbook.body,
    runToken: "",
  };
  state.jobs.unshift(job);
  state.selectedJobId = job.id;
  state.selectedDesk = "all";
  log(`Issued to ${DESK_BY_ID[deskId].name}: ${brief}`);
  els.brief.value = "";
  persist();
  render();
  runJob(job.id);
}

async function issueAgentBrief(brief, deskId) {
  const desk = DESK_BY_ID[deskId];
  const playbook = runPlaybook(deskId, brief, state.company, state.evolution);
  const job = {
    id: newId("job"),
    deskId,
    brief,
    kind: playbook.kind ?? "work",
    status: "queued",
    title: playbook.title,
    body: "",
    steps: playbook.steps.map((step) => ({ ...step, done: false })),
    notes: "",
    seed: false,
    source: "agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _file: "",
    runToken: newId("run"),
  };
  state.jobs.unshift(job);
  state.selectedJobId = job.id;
  state.selectedDesk = "all";
  log(`Issued to ${desk?.name ?? deskId} (live agent): ${brief}`);
  persist();
  render();
  runJob(job.id, { agentFetch: true });
  try {
    const res = await fetch(`/api/desk/${deskId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief,
        company: state.company,
        evolution: state.evolution,
        jobId: job.id,
      }),
    });
    const payload = await res.json();
    const current = state.jobs.find((item) => item.id === job.id);
    if (!current || current.runToken !== job.runToken) return;
    if (!payload.ok) throw new Error(payload.error ?? "agent_failed");
    current.title = payload.title ?? current.title;
    current.kind = payload.kind ?? current.kind;
    current.source = payload.source ?? "agent";
    if (payload.reason) current.agentNote = payload.reason;
    current.steps = (payload.steps ?? current.steps).map((step) => ({ ...step, done: true }));
    current.body = payload.body ?? payload.bodyMarkdown ?? "";
    delete current._file;
    current.status = "filed";
    if (current.deskId === "forge") {
      current.kind = "proposal";
      current.proposal = proposalFromForgeBody(current.body, {
        id: newId("evo"),
        sourceJobId: current.id,
        title: current.title,
      });
    }
    current.updatedAt = Date.now();
    log(
      `${payload.source === "agent" ? desk?.name + " agent" : desk?.name + " playbook"} filed: ${current.title}`,
    );
    persist();
    render();
  } catch (error) {
    const current = state.jobs.find((item) => item.id === job.id);
    if (!current) return;
    const fallback = runPlaybook(deskId, brief, state.company, state.evolution);
    current.title = fallback.title;
    current.body = fallback.body;
    current.kind = fallback.kind ?? current.kind;
    current.status = "filed";
    current.source = "playbook";
    current.agentNote = error instanceof Error ? error.message : "agent_error";
    current.steps = fallback.steps.map((step) => ({ ...step, done: true }));
    current.updatedAt = Date.now();
    log(`${desk?.name ?? deskId} fell back to playbook: ${current.title}`);
    persist();
    render();
  }
}

function issueRecursiveForgeBrief(sourceJob) {
  const brief = buildForgeBriefFromJob(sourceJob, state.company);
  const playbook = runPlaybook("forge", brief, state.company, state.evolution);
  const job = {
    id: newId("job"),
    deskId: "forge",
    brief,
    kind: "proposal",
    status: "queued",
    title: playbook.title,
    parentJobId: sourceJob.id,
    body: "",
    steps: playbook.steps.map((step) => ({ ...step, done: false })),
    notes: "",
    seed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _file: playbook.body,
    runToken: "",
  };
  state.jobs.unshift(job);
  state.selectedJobId = job.id;
  log(`Recursive cycle: Forge proposal for ${DESK_BY_ID[sourceJob.deskId]?.name ?? sourceJob.deskId}`);
  persist();
  render();
  runJob(job.id);
}

function runJob(jobId, options = {}) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  const token = newId("run");
  job.runToken = token;
  job.status = "working";
  job.updatedAt = Date.now();
  persist();
  render();

  const steps = job.steps ?? [];
  let i = 0;
  const tick = () => {
    const current = state.jobs.find((item) => item.id === jobId);
    if (!current || current.status === "killed" || current.runToken !== token) return;
    if (i < steps.length) {
      current.steps[i].done = true;
      current.updatedAt = Date.now();
      i += 1;
      persist();
      render();
      window.setTimeout(tick, options.agentFetch ? STEP_MS * 2 : STEP_MS);
      return;
    }
    if (options.agentFetch) return;
    current.status = "filed";
    current.body = current._file || current.body;
    delete current._file;
    if (current.deskId === "forge" || current.kind === "proposal") {
      current.kind = "proposal";
      current.proposal = proposalFromForgeBody(current.body, {
        id: newId("evo"),
        sourceJobId: current.id,
        title: current.title,
      });
    }
    current.updatedAt = Date.now();
    log(`${DESK_BY_ID[current.deskId].name} filed: ${current.title}`);
    persist();
    render();
  };
  window.setTimeout(tick, STEP_MS);
}

async function acceptProposal(job) {
  const proposal = proposalFromForgeBody(job.body, {
    id: newId("evo"),
    sourceJobId: job.id,
    title: job.title,
  });
  if (!proposal) {
    log("Could not parse evolution proposal — return to Forge with clearer sections.");
    persist();
    render();
    return;
  }
  proposal.acceptedAt = Date.now();
  if (!state.evolution) state.evolution = { applied: [], lastMaterializedAt: null };
  state.evolution.applied.unshift(proposal);
  job.status = "accepted";
  job.proposal = proposal;
  job.updatedAt = Date.now();
  log(`Evolution accepted: ${proposal.title} → ${proposal.targetDesk}`);
  try {
    const res = await fetch("/api/evolution/materialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applied: state.evolution.applied }),
    });
    const payload = await res.json();
    if (payload.ok) {
      state.evolution.lastMaterializedAt = Date.now();
      log("Materialized evolution appendices for all desk agents (.flux/evolution + agents/*).");
    }
  } catch {
    log("Evolution saved in browser. Run npm run dev to materialize to the Scout agent.");
  }
  persist();
  render();
}

function onFileAction(act) {
  const job = selectedJob();
  if (!job) return;
  if (act === "accept") {
    if (job.kind === "proposal") {
      void acceptProposal(job);
      return;
    }
    job.status = "accepted";
    job.updatedAt = Date.now();
    log(`Accepted: ${job.title}`);
  } else if (act === "kill") {
    job.status = "killed";
    job.updatedAt = Date.now();
    log(`Killed: ${job.title}`);
  } else if (act === "recursive") {
    issueRecursiveForgeBrief(job);
    return;
  } else if (act === "return") {
    const notes = document.getElementById("return-notes")?.value.trim() ?? "";
    job.notes = notes;
    job.status = "queued";
    job.steps = job.steps.map((step) => ({ ...step, done: false }));
    const replay = runPlaybook(
      job.deskId,
      `${job.brief}${notes ? `\n\nReturn notes: ${notes}` : ""}`,
      state.company,
      state.evolution,
    );
    job.title = replay.title;
    job._file = replay.body;
    job.steps = replay.steps.map((step) => ({ ...step, done: false }));
    job.updatedAt = Date.now();
    log(`Returned to ${DESK_BY_ID[job.deskId].name}${notes ? " with notes" : ""}`);
    persist();
    render();
    runJob(job.id);
    return;
  }
  persist();
  render();
}

function bind() {
  els.clock = $("mast-clock");
  els.orchestrator = $("mast-orchestrator");
  els.companyName = $("mast-company");
  els.deskList = $("desk-list");
  els.mission = $("mission");
  els.orchestratorInput = $("orchestrator-name");
  els.brief = $("brief");
  els.deskSelect = $("desk-select");
  els.routeHint = $("route-hint");
  els.board = $("board");
  els.file = $("file");
  els.filePane = $("file-pane");
  els.log = $("log");
  els.form = $("brief-form");

  els.deskSelect.innerHTML =
    `<option value="auto">Auto-route</option>` +
    DESKS.map((desk) => `<option value="${esc(desk.id)}">${esc(desk.name)} — ${esc(desk.job)}</option>`).join("");

  els.form.addEventListener("submit", issueBrief);
  els.brief.addEventListener("input", renderRouteHint);
  els.deskSelect.addEventListener("change", renderRouteHint);
  els.brief.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      issueBrief(event);
    }
  });

  els.deskList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-desk]");
    if (!btn) return;
    state.selectedDesk = btn.getAttribute("data-desk");
    persist();
    render();
  });

  els.board.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-job]");
    if (!btn) return;
    state.selectedJobId = btn.getAttribute("data-job");
    persist();
    render();
  });

  els.file.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-act]");
    if (!btn) return;
    onFileAction(btn.getAttribute("data-act"));
  });

  els.mission.addEventListener("change", () => {
    state.company.mission = els.mission.value.trim() || state.company.mission;
    persist();
    render();
  });
  els.orchestratorInput.addEventListener("change", () => {
    state.company.orchestrator = els.orchestratorInput.value.trim() || "Orchestrator";
    persist();
    render();
  });

  const linkedForm = document.getElementById("linked-source-form");
  linkedForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const urlInput = document.getElementById("linked-source-url");
    const labelInput = document.getElementById("linked-source-label");
    const check = validateSourceInput({
      url: urlInput?.value,
      label: labelInput?.value,
    });
    if (!check.ok) {
      log("Could not link site — check the URL.");
      return;
    }
    state.linkedSources = [...(state.linkedSources ?? []), check.source];
    persist();
    await persistLinkedSourcesToServer();
    urlInput.value = "";
    labelInput.value = "";
    log(`Linked ${check.source.label} for 24/7 Scout watch.`);
    renderLinkedSources();
  });

  document.getElementById("linked-source-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-unlink]");
    if (!btn) return;
    const id = btn.getAttribute("data-unlink");
    state.linkedSources = (state.linkedSources ?? []).filter((s) => s.id !== id);
    persist();
    await persistLinkedSourcesToServer();
    log("Removed linked site.");
    renderLinkedSources();
  });

  document.getElementById("linked-source-sync")?.addEventListener("click", () => {
    syncLinkedSourcesNow();
  });

  els.agentSettings = $("agent-settings");
  els.agentSettings?.addEventListener("change", (event) => {
    const modeSel = event.target.closest("[data-agent-mode]");
    if (modeSel) {
      const id = modeSel.getAttribute("data-agent-mode");
      if (!state.agents[id]) state.agents[id] = defaultAgentDeskConfig();
      state.agents[id].mode = modeSel.value === "agent" ? "agent" : "playbook";
      persist();
      renderRouteHint();
      renderDesks();
      return;
    }
    const recur = event.target.closest("[data-agent-recursive]");
    if (recur) {
      const id = recur.getAttribute("data-agent-recursive");
      if (!state.agents[id]) state.agents[id] = defaultAgentDeskConfig();
      state.agents[id].recursive = recur.checked;
      persist();
      renderDesks();
    }
  });

  $("reset-company").addEventListener("click", () => {
    if (!window.confirm("Reset the floor to the three founding files?")) return;
    const next = resetState();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, next);
    persist();
    render();
  });

  window.setInterval(() => {
    els.clock.textContent = `${mastClock()} Mauritius`;
  }, 30_000);
}

bind();
render();
fetchAgentPoolHealth().then((health) => {
  agentPoolHealth = health;
  renderAgentPoolStatus();
});
pullLinkedSourcesFromServer().then(() => renderLinkedSources());

for (const job of state.jobs) {
  if (job.status !== "queued" && job.status !== "working") continue;
  if (!job._file) {
    const playbook = runPlaybook(job.deskId, job.brief, state.company, state.evolution);
    job._file = playbook.body;
    job.title = playbook.title;
    job.steps = playbook.steps.map((step) => ({ ...step, done: false }));
  }
  runJob(job.id);
}
