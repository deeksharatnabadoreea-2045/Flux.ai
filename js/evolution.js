/** Orchestrator-gated evolution: agents propose, humans accept before apply. */

export const CHANGE_KINDS = [
  "instructions",
  "tool",
  "architecture",
  "eval",
  "routing",
  "playbook",
];

export function emptyEvolution() {
  return { applied: [], lastMaterializedAt: null };
}

export function normalizeProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const targetDesk = String(raw.targetDesk ?? "all").trim() || "all";
  const changeKind = CHANGE_KINDS.includes(raw.changeKind) ? raw.changeKind : "instructions";
  const title = String(raw.title ?? "").trim();
  const hypothesis = String(raw.hypothesis ?? "").trim();
  const change = String(raw.change ?? "").trim();
  const metric = String(raw.metric ?? "").trim();
  const rollback = String(raw.rollback ?? "").trim();
  const patch = String(raw.patch ?? "").trim();
  if (!title || !change || !patch) return null;
  return {
    id: raw.id ?? "",
    targetDesk,
    changeKind,
    title,
    hypothesis,
    change,
    metric,
    rollback,
    patch,
    acceptedAt: raw.acceptedAt ?? null,
    sourceJobId: raw.sourceJobId ?? null,
  };
}

export function proposalFromForgeBody(body, meta = {}) {
  const fields = parseForgeSections(body);
  const targetDesk = (fields.target ?? fields["target desk"] ?? "all").toLowerCase();
  return normalizeProposal({
    id: meta.id,
    targetDesk: targetDesk.replace(/\s+/g, ""),
    changeKind: (fields.kind ?? fields["change kind"] ?? "instructions").toLowerCase(),
    title: fields.title ?? meta.title ?? "Evolution proposal",
    hypothesis: fields.hypothesis ?? "",
    change: fields.change ?? fields.proposed ?? "",
    metric: fields.metric ?? fields["success metric"] ?? "",
    rollback: fields.rollback ?? "",
    patch: fields.patch ?? fields["patch text"] ?? "",
    sourceJobId: meta.sourceJobId,
  });
}

function parseForgeSections(body) {
  const out = {};
  const lines = String(body ?? "").split(/\r?\n/);
  let key = "";
  let buf = [];
  const flush = () => {
    if (!key) return;
    out[key.toLowerCase()] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const md = line.match(/^##\s+(.+?)\s*$/);
    if (md) {
      flush();
      key = md[1].replace(/\s+/g, " ").trim();
      continue;
    }
    if (key) buf.push(line);
  }
  flush();
  return out;
}

export function appliesToDesk(proposal, deskId) {
  if (!proposal) return false;
  const target = proposal.targetDesk;
  if (target === "all" || target === "company") return true;
  return target === deskId;
}

export function evolutionBlockForDesk(applied, deskId) {
  const hits = (applied ?? []).filter((p) => appliesToDesk(p, deskId));
  if (!hits.length) return "";
  return hits
    .map(
      (p, i) =>
        `### Accepted change ${i + 1}: ${p.title}\n` +
        `Kind: ${p.changeKind} · Target: ${p.targetDesk}\n\n` +
        `${p.patch}`,
    )
    .join("\n\n");
}

export function renderAppendixMarkdown(applied) {
  const list = applied ?? [];
  if (!list.length) {
    return "# Orchestrator-approved evolution\n\n_No accepted changes yet._\n";
  }
  const parts = [
    "# Orchestrator-approved evolution",
    "",
    "The orchestrator accepted these changes. They override conflicting guidance above.",
    "",
  ];
  for (const p of list) {
    parts.push(`## ${p.title}`);
    parts.push("");
    parts.push(`- **Target:** ${p.targetDesk}`);
    parts.push(`- **Kind:** ${p.changeKind}`);
    if (p.hypothesis) parts.push(`- **Hypothesis:** ${p.hypothesis}`);
    if (p.metric) parts.push(`- **Success metric:** ${p.metric}`);
    if (p.rollback) parts.push(`- **Rollback:** ${p.rollback}`);
    parts.push("");
    parts.push(p.patch);
    parts.push("");
  }
  return parts.join("\n");
}

export function groupAppliedByAgent(applied) {
  const scout = [];
  const company = [];
  for (const p of applied ?? []) {
    if (p.targetDesk === "scout") scout.push(p);
    else if (p.targetDesk === "all" || p.targetDesk === "company") {
      company.push(p);
      scout.push(p);
    }
  }
  return { scout, company };
}
