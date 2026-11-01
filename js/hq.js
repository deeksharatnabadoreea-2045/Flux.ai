import { DESKS, DESK_BY_ID, routeBrief, runPlaybook } from "./desks.js";
import { loadState, saveState, resetState, newId } from "./store.js";

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
      return `<button class="desk${active}" type="button" data-desk="${esc(desk.id)}" aria-pressed="${desk.id === state.selectedDesk}">
        <span class="desk-code">${esc(desk.code)}</span>
        <span class="desk-copy">
          <span class="desk-name">${esc(desk.name)}</span>
          <span class="desk-job">${esc(desk.job)} · ${esc(count)}</span>
        </span>
      </button>`;
    })
    .join("");

  els.mission.value = state.company.mission;
  els.orchestratorInput.value = state.company.orchestrator;
}

function renderRouteHint() {
  const id = liveRoute();
  const desk = DESK_BY_ID[id];
  els.routeHint.textContent = desk
    ? `Will file to ${desk.name} — ${desk.job.toLowerCase()}. ${desk.duty}`
    : "";
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
      return `<button class="job${active} is-${esc(job.status)}" type="button" data-job="${esc(job.id)}">
        <span class="job-code">${esc(desk?.code ?? "???")}</span>
        <span class="job-body">
          <span class="job-title">${esc(job.title || job.brief)}</span>
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
  const actions = filed
    ? `<div class="file-actions">
        <button type="button" class="btn btn-primary" data-act="accept">Accept to record</button>
        <button type="button" class="btn" data-act="return">Return to desk</button>
        <button type="button" class="btn btn-danger" data-act="kill">Kill</button>
      </div>
      <label class="return-notes">Return notes
        <textarea id="return-notes" rows="3" placeholder="What the desk must fix."></textarea>
      </label>`
    : accepted
      ? `<p class="file-seal">On the company record. The desk is done.</p>`
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
  const playbook = runPlaybook(deskId, brief, state.company);
  const job = {
    id: newId("job"),
    deskId,
    brief,
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

function runJob(jobId) {
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
      window.setTimeout(tick, STEP_MS);
      return;
    }
    current.status = "filed";
    current.body = current._file || current.body;
    delete current._file;
    current.updatedAt = Date.now();
    log(`${DESK_BY_ID[current.deskId].name} filed: ${current.title}`);
    persist();
    render();
  };
  window.setTimeout(tick, STEP_MS);
}

function onFileAction(act) {
  const job = selectedJob();
  if (!job) return;
  if (act === "accept") {
    job.status = "accepted";
    job.updatedAt = Date.now();
    log(`Accepted: ${job.title}`);
  } else if (act === "kill") {
    job.status = "killed";
    job.updatedAt = Date.now();
    log(`Killed: ${job.title}`);
  } else if (act === "return") {
    const notes = document.getElementById("return-notes")?.value.trim() ?? "";
    job.notes = notes;
    job.status = "queued";
    job.steps = job.steps.map((step) => ({ ...step, done: false }));
    const replay = runPlaybook(job.deskId, `${job.brief}${notes ? `\n\nReturn notes: ${notes}` : ""}`, state.company);
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

for (const job of state.jobs) {
  if (job.status !== "queued" && job.status !== "working") continue;
  if (!job._file) {
    const playbook = runPlaybook(job.deskId, job.brief, state.company);
    job._file = playbook.body;
    job.title = playbook.title;
    job.steps = playbook.steps.map((step) => ({ ...step, done: false }));
  }
  runJob(job.id);
}
