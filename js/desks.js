/** Flux.ai desks — the agent jobs that do the manual work. */

import { evolutionBlockForDesk } from "./evolution.js";
import { recursiveImprovementBlock, recursiveStepLabel } from "./recursive-improve.js";

export { FOUNDING_MISSION } from "./platform.js";

export const DESKS = [
  {
    id: "scout",
    code: "SCT",
    name: "Scout",
    job: "Research",
    duty: "Find what is moving. Map a market, a competitor, or a question before we spend a week on it.",
    verbs: [
      "research",
      "market",
      "competitor",
      "landscape",
      "why",
      "find",
      "scout",
      "trend",
      "signal",
      "who is",
      "what is",
      "survey",
      "clinical",
      "mechanism",
      "biomarker",
      "pharmacology",
      "pubmed",
    ],
  },
  {
    id: "maker",
    code: "MKR",
    name: "Maker",
    job: "Product",
    duty: "Turn a brief into a spec, a sequence of work, and a definition of done.",
    verbs: [
      "build",
      "spec",
      "product",
      "ship",
      "feature",
      "design",
      "implement",
      "app",
      "hq",
      "floor",
      "prototype",
      "make",
      "simulate",
      "simulation",
      "in-silico",
      "insilico",
      "digital twin",
      "virtual trial",
      "synthetic cohort",
      "pipeline",
    ],
  },
  {
    id: "voice",
    code: "VOX",
    name: "Voice",
    job: "Writing",
    duty: "Write the public sentence. Manifesto, page, post, or email — in the company's mouth.",
    verbs: [
      "write",
      "copy",
      "post",
      "blog",
      "email",
      "announce",
      "manifesto",
      "headline",
      "tagline",
      "draft",
      "landing",
      "about",
    ],
  },
  {
    id: "floor",
    code: "FLR",
    name: "Floor",
    job: "Operations",
    duty: "Keep the machine running. Checklists, cadence, owners, and what we do when it breaks.",
    verbs: [
      "ops",
      "operate",
      "process",
      "checklist",
      "weekly",
      "cadence",
      "run",
      "hire",
      "onboard",
      "admin",
      "sop",
      "routine",
    ],
  },
  {
    id: "validator",
    code: "VLD",
    name: "Validator",
    job: "Audit",
    duty:
      "Red-team science and code on the platform. Block wrong trials logic, overclaim, and unsafe architecture.",
    verbs: [
      "validate",
      "validation",
      "audit",
      "sanity",
      "red team",
      "red-team",
      "fact-check",
      "fact check",
      "overclaim",
      "wrong science",
      "unsafe",
      "review code",
      "code review",
      "scientific review",
      "block",
      "concordance check",
    ],
  },
  {
    id: "ledger",
    code: "LDG",
    name: "Ledger",
    job: "Numbers",
    duty: "Count before we commit. Price, cost, metric, kill criteria.",
    verbs: [
      "price",
      "cost",
      "metric",
      "revenue",
      "burn",
      "margin",
      "unit",
      "legal",
      "risk",
      "budget",
      "model",
      "kpi",
      "trial",
      "endpoint",
      "efficacy",
      "accuracy",
      "validation",
      "calibration",
      "concordance",
      "benchmark",
    ],
  },
  {
    id: "wire",
    code: "WRE",
    name: "Wire",
    job: "Outbound",
    duty: "Talk to the outside. The ask, the draft, the follow-up.",
    verbs: [
      "outreach",
      "partner",
      "sales",
      "intro",
      "customer",
      "pitch",
      "meet",
      "call",
      "inbound",
      "outbound",
      "recruit",
      "investor",
    ],
  },
  {
    id: "forge",
    code: "FRG",
    name: "Forge",
    job: "Evolution",
    duty: "Propose self-improvement and architecture changes. Nothing ships until the orchestrator accepts.",
    verbs: [
      "improve",
      "evolve",
      "evolution",
      "architecture",
      "refactor",
      "hillclimb",
      "self-improve",
      "retool",
      "redesign",
      "upgrade",
      "change how",
    ],
  },
];

export const DESK_BY_ID = Object.fromEntries(DESKS.map((desk) => [desk.id, desk]));

const VERB_WORDS = new Set(
  DESKS.flatMap((desk) => desk.verbs.map((verb) => verb.split(/\s+/)[0])).concat([
    "put",
    "create",
    "make",
    "keep",
    "set",
    "get",
    "give",
    "add",
    "start",
    "open",
    "close",
  ]),
);

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "with",
  "our",
  "we",
  "i",
  "my",
  "me",
  "us",
  "this",
  "that",
  "please",
  "need",
  "want",
  "should",
  "would",
  "could",
  "from",
  "into",
  "about",
  "just",
]);

export function parseBrief(brief) {
  const raw = String(brief ?? "").trim();
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstSentence = (raw.split(/(?<=[.?!])\s+/)[0] || raw).trim();
  const isQuestion = /\?/.test(raw) || /^(what|why|how|who|where|which|should)\b/i.test(firstSentence);
  const words = raw.toLowerCase().match(/[a-z0-9][a-z0-9&+.-]*/g) ?? [];
  const proper = raw.match(/\b[A-Z][A-Za-z0-9&.+-]{1,}\b/g) ?? [];
  const subject =
    proper.find((word) => !/^(i|we)$/i.test(word) && !VERB_WORDS.has(word.toLowerCase())) ||
    firstNoun(words) ||
    "this work";
  return { raw, lines, firstSentence, isQuestion, words, proper, subject };
}

function firstNoun(words) {
  for (const word of words) {
    if (!STOP.has(word) && !VERB_WORDS.has(word) && word.length > 2) return word;
  }
  return "";
}

export function routeBrief(brief) {
  const text = String(brief ?? "").toLowerCase();
  if (!text.trim()) return "maker";

  let best = { id: "maker", score: 0 };
  for (const desk of DESKS) {
    let score = 0;
    for (const verb of desk.verbs) {
      if (text.includes(verb)) score += verb.includes(" ") ? 3 : 2;
    }
    if (score > best.score) best = { id: desk.id, score };
  }

  if (best.score === 0) {
    const parsed = parseBrief(brief);
    return parsed.isQuestion ? "scout" : "maker";
  }
  return best.id;
}

export function runPlaybook(deskId, brief, company = {}, evolution = {}) {
  const desk = DESK_BY_ID[deskId] ?? DESK_BY_ID.maker;
  const parsed = parseBrief(brief);
  const evolutionBlock = evolutionBlockForDesk(evolution.applied, desk.id);
  const ctx = { desk, parsed, company: normalizeCompany(company), evolutionBlock };
  switch (desk.id) {
    case "scout":
      return scoutPlaybook(ctx);
    case "voice":
      return voicePlaybook(ctx);
    case "floor":
      return floorPlaybook(ctx);
    case "ledger":
      return ledgerPlaybook(ctx);
    case "validator":
      return validatorPlaybook(ctx);
    case "wire":
      return wirePlaybook(ctx);
    case "forge":
      return forgePlaybook(ctx);
    default:
      return makerPlaybook(ctx);
  }
}

function normalizeCompany(company) {
  return {
    name: company?.name?.trim() || "Flux.ai",
    mission:
      company?.mission?.trim() ||
      "A company of one. The founder orchestrates. Agents do the manual jobs.",
    orchestrator: company?.orchestrator?.trim() || "Orchestrator",
  };
}

function stepsFor(desk, labels) {
  return labels.map((label) => ({ desk: desk.name, label, done: false }));
}

function finalizeDeskBody(body, desk, evolutionBlock) {
  let out = body;
  if (desk.id !== "forge") {
    out = `${out}\n\n${recursiveImprovementBlock(desk)}`;
  }
  if (evolutionBlock?.trim()) {
    out = `${out}\n\nOrchestrator-approved evolution (honor on this desk)\n${evolutionBlock}`;
  }
  return out;
}

function withSteps(desk, labels, includeRecursive = desk.id !== "forge") {
  const list = [...labels];
  if (includeRecursive) list.push(recursiveStepLabel());
  return stepsFor(desk, list);
}

function scoutPlaybook({ desk, parsed, company, evolutionBlock }) {
  const q = parsed.isQuestion
    ? parsed.firstSentence.replace(/\?+$/, "") + "?"
    : `What do we need to know before we act on “${clip(parsed.firstSentence, 90)}”?`;
  const body = [
    `# ${desk.name} file — ${clip(parsed.subject, 48)}`,
    "",
    `Question`,
    q,
    "",
    `Why it matters to ${company.name}`,
    `${company.mission}`,
    `If we skip this, we spend founder time on a job we have not named. Scout files the map first.`,
    "",
    "Working thesis",
    `${company.name} wins if the orchestrator only touches judgment, and desks absorb repetition. “${clip(parsed.firstSentence, 140)}” is either a desk job, a founder decision, or noise. This file sorts it.`,
    "",
    "Landscape to verify",
    `- Who already sells a company-of-agents operating system, and what they charge.`,
    `- Where founders still do ${parsed.subject} by hand, and what they pay in hours.`,
    `- What a first customer would need on day one besides a brief box.`,
    `- Which proof would make a stranger trust a desk with real work.`,
    "",
    "Signals",
    `- People describing themselves as orchestrators, not operators.`,
    `- Teams posting role descriptions that a playbook could swallow.`,
    `- Tools that chat, but do not file work a founder can accept or kill.`,
    "",
    "Next five finds",
    `1. List three companies adjacent to “${clip(parsed.subject, 60)}” and quote their homepage promise.`,
    `2. Capture one founder interview or thread where this job is complained about.`,
    `3. Note the price of the closest paid substitute.`,
    `4. Write the smallest artifact a desk could file that would still be useful.`,
    `5. Name the kill criterion — what would make us drop this line of work.`,
    "",
    "Recommendation",
    parsed.isQuestion
      ? "Hold spend. Run the five finds. File a one-page answer. Then the orchestrator decides go / wait / ignore."
      : "Treat this as a live line of work. Maker can spec the smallest useful file. Scout should still complete the five finds this week.",
  ].join("\n");

  return {
    title: `Scout: ${clip(parsed.firstSentence, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "Restate the question",
      "Tie it to the company mission",
      "Map the landscape",
      "List the next finds",
      "File a recommendation",
    ]),
  };
}

function makerPlaybook({ desk, parsed, company, evolutionBlock }) {
  const job = parsed.firstSentence.replace(/\.$/, "");
  const body = [
    `# ${desk.name} file — ${clip(job, 64)}`,
    "",
    "Job to be done",
    `${company.orchestrator} should be able to issue this brief and receive a file they can accept, return, or kill — without doing the manual work themselves.`,
    `Brief: ${parsed.raw}`,
    "",
    "Non-goals",
    `- Do not impersonate a chat companion. This is a desk, not a friend.`,
    `- Do not hide the file. The orchestrator reviews work, not vibes.`,
    `- Do not add a second product. ${company.name} is the floor.`,
    "",
    "Spec",
    `1. A brief is issued in one field. Auto-route names a desk. The orchestrator can override.`,
    `2. The desk shows its steps while it works, then files a document.`,
    `3. The file has a title, a body, and three decisions: Accept, Return, Kill.`,
    `4. Accepted files become company record. Returned files re-enter the desk with notes.`,
    `5. The mission stays visible. Every file has to survive it.`,
    "",
    "Build order",
    `- Floor shell: mast, desks, brief, board, file.`,
    `- Routing and playbooks for the six desks.`,
    `- Persistence so the company still exists after a refresh.`,
    `- Founding files so the floor is not empty on day one.`,
    `- Proof: issue a live brief and watch a desk file it.`,
    "",
    "Open questions",
    `- When does a desk stop being a playbook and become a hosted agent?`,
    `- Which job, done well, would make a stranger stay?`,
    "",
    "Definition of done",
    `An orchestrator who has never seen ${company.name} can issue “${clip(job, 80)}” and get a file they could act on in one sitting.`,
  ].join("\n");

  return {
    title: `Maker: ${clip(job, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "Name the job to be done",
      "Cut non-goals",
      "Write the spec",
      "Order the build",
      "Set definition of done",
    ]),
  };
}

function voicePlaybook({ desk, parsed, company, evolutionBlock }) {
  const promise = promiseFrom(parsed, company);
  const object = parsed.firstSentence.replace(
    /^(write|draft|research|build|specify|make|create|find|price|announce)\s+/i,
    "",
  );
  const body = [
    `# ${desk.name} file — ${clip(parsed.subject, 48)}`,
    "",
    "Audience",
    `A founder who is still the operator, and is tired of it. They do not want another chat. They want a staff.`,
    "",
    "Promise",
    promise,
    "",
    "Homepage block",
    `${company.name}`,
    `You orchestrate. Agents do the jobs.`,
    ``,
    `${company.mission}`,
    ``,
    `Issue a brief. A desk files the work. You decide what ships.`,
    "",
    "One-line",
    `${company.name} is a company of one with a staff of desks.`,
    "",
    "Short post",
    `I am not hiring for ${parsed.subject} yet.`,
    `I am giving that job to a desk.`,
    ``,
    `The founder is the orchestrator.`,
    `Manual work is an agent’s job.`,
    `If the file is wrong, I return it. If it is done, I accept it.`,
    ``,
    `That is the whole company.`,
    "",
    "Do not say",
    `- “Unlock”, “empower”, “leverage”, “supercharge”.`,
    `- That the agent replaces judgment. It replaces repetition.`,
    `- That the product is magic. It is a floor with desks.`,
  ].join("\n");

  return {
    title: `Voice: ${clip(object, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "Name the audience",
      "Lock the promise",
      "Draft the homepage block",
      "Write a short post",
      "List the forbidden words",
    ]),
  };
}

function floorPlaybook({ desk, parsed, company, evolutionBlock }) {
  const outcome = parsed.firstSentence.replace(/\.$/, "");
  const body = [
    `# ${desk.name} file — operations`,
    "",
    "Outcome",
    `${outcome}.`,
    `Owner of judgment: ${company.orchestrator}. Owner of execution: a named desk.`,
    "",
    "Checklist",
    `1. Restate the outcome in one sentence the orchestrator can accept.`,
    `2. Name the desk that owns the work. Do not leave it on the founder.`,
    `3. Issue the brief. Wait for a file. Do not hover in the steps.`,
    `4. Accept, return with notes, or kill. No fourth state.`,
    `5. Log the decision on the company record.`,
    `6. If the same brief appears twice, promote it to a standing cadence.`,
    "",
    "Cadence",
    `- Morning: orchestrator issues at most three briefs.`,
    `- Midday: desks file. Orchestrator reviews the pile, not the chat.`,
    `- Evening: accept or kill. Returned work is tomorrow’s first brief.`,
    "",
    "Standing jobs",
    `- Scout: one landscape file a week.`,
    `- Maker: one spec or cut a week.`,
    `- Voice: one public sentence a week.`,
    `- Ledger: one number we would bet the week on.`,
    `- Wire: one outbound ask, or a written reason to stay quiet.`,
    "",
    "Failure mode",
    `If ${company.orchestrator} starts doing the desk’s job “just this once”, the company has no staff. Return the work to the desk. Shrink the brief. Do not take the chair.`,
  ].join("\n");

  return {
    title: `Floor: ${clip(outcome, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "State the outcome",
      "Write the checklist",
      "Set cadence",
      "Name standing jobs",
      "Record the failure mode",
    ]),
  };
}

function validatorPlaybook({ desk, parsed, company, evolutionBlock }) {
  const body = [
    `# ${desk.name} audit — ${clip(parsed.subject, 48)}`,
    "",
    "## Scope",
    parsed.raw,
    "",
    "## Hypothesis under test",
    `The work under review implies a testable claim about: ${clip(parsed.subject, 120)}.`,
    "",
    "## Predictions",
    `- If the claim is sound, reproducible inputs (snapshots, schemas, harness output) will support it.`,
    `- If false, observations will contradict registry fields or lack lineage.`,
    "",
    "## Methods and reproducibility",
    `Apply docs/SCIENTIFIC-METHOD.md; require frozen ingest ids or repo paths for any factual statement.`,
    "",
    "## Observations (data in hand)",
    `Playbook mode — no live agent session. Re-run with Validator live agent for snapshot-linked observations.`,
    "",
    "## Inferences (conclusions)",
    `Cannot certify science in playbook mode; treat upstream files as unverified until a live Validator audit passes.`,
    "",
    "## Falsifiability",
    `Disproved if claimed endpoints or cohort rules cannot be traced to registry JSON or schema-valid artifacts.`,
    "",
    "## Uncertainty",
    `High in playbook fallback — orchestrator should not accept efficacy or trial-replacement claims from this file alone.`,
    "",
    "## Fake-science screening",
    `Fail if brief or upstream work treats marketing as data, invents citations, or claims concordance without L1 harness.`,
    "",
    "## Validation ladder stage",
    `Default L0 until engine/harness produces replay packets.`,
    "",
    "## Code / platform findings",
    `- Missing dataLineage in engine/schemas blocks ship.`,
    `- Evolution changes require Forge accept.`,
    "",
    "## Verdict",
    `fix`,
    "",
    "## Required fixes",
    `1. Re-issue to live Validator agent with npm run dev.`,
    `2. Attach snapshot ids or NCT ids in Observations.`,
    "",
    "## Recommendation",
    `wait`,
  ].join("\n");

  return {
    title: `Validator: ${clip(parsed.firstSentence, 72)}`,
    kind: "audit",
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "State hypothesis",
      "Separate observations from inferences",
      "Check falsifiability",
      "Screen for fake science",
      "Issue verdict",
    ]),
  };
}

function ledgerPlaybook({ desk, parsed, company, evolutionBlock }) {
  const body = [
    `# ${desk.name} file — ${clip(parsed.subject, 48)}`,
    "",
    "What we are counting",
    parsed.raw,
    "",
    "Unit of value",
    `One accepted file that ${company.orchestrator} did not have to write. If a desk files work the founder still rewrites, the unit is zero.`,
    "",
    "Simple model",
    `- Founder hours available for judgment this week: 10.`,
    `- Hours currently lost to ${parsed.subject}: unknown — log them for five days.`,
    `- Hours a desk should absorb: the whole of that unknown.`,
    `- Cost of a bad accept: rework, plus the trust the floor loses.`,
    "",
    "Price of the substitute",
    `A contractor for this job, a tool subscription, or the founder’s night. Name the number before we add a desk ritual.`,
    "",
    "Metrics that matter",
    `- Briefs issued / files accepted / files returned / files killed.`,
    `- Time from issue to file.`,
    `- Founder minutes spent inside a file (review is allowed; rewriting is not).`,
    "",
    "Kill criteria",
    `Kill this line of work if three accepted files in a row still require the founder to redo the job, or if nobody outside ${company.name} would pay for the file.`,
  ].join("\n");

  return {
    title: `Ledger: ${clip(parsed.firstSentence, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "Name the unit of value",
      "Sketch the model",
      "List the metrics",
      "Write kill criteria",
    ]),
  };
}

function wirePlaybook({ desk, parsed, company, evolutionBlock }) {
  const ask = parsed.firstSentence.replace(/\.$/, "");
  const body = [
    `# ${desk.name} file — outbound`,
    "",
    "Who",
    `A person who already feels the pain in “${clip(parsed.subject, 80)}”. Not a stranger who needs a lecture on agents.`,
    "",
    "Why now",
    `${company.name} is live as a floor. We do not wait for a perfect staff. We ask for one conversation that can tell us if a desk files useful work.`,
    "",
    "The ask",
    ask,
    "",
    "Draft",
    `Subject: A company of one — quick look at ${clip(parsed.subject, 40)}`,
    ``,
    `I run ${company.name}. I am the orchestrator. Agents do the manual jobs.`,
    ``,
    `I am not selling a demo. I am asking whether this job is still on you:`,
    `${parsed.raw}`,
    ``,
    `If it is, I want twenty minutes. I will show the floor, not a slide.`,
    ``,
    `— ${company.orchestrator}`,
    "",
    "Follow-up",
    `Day 3: one sentence, no garnish — “still useful to talk, or should I close this?”`,
    `Day 10: kill the thread. Do not chase. File what we learned.`,
    "",
    "Do not send if",
    `We cannot show an accepted file for this job. Wire does not pitch empty desks.`,
  ].join("\n");

  return {
    title: `Wire: ${clip(ask, 72)}`,
    body: finalizeDeskBody(body, desk, evolutionBlock),
    steps: withSteps(desk, [
      "Name who we are asking",
      "Write the ask",
      "Draft the message",
      "Set the follow-up",
      "State the do-not-send rule",
    ]),
  };
}

function forgePlaybook({ desk, parsed, company, evolutionBlock }) {
  const topic = clip(parsed.firstSentence.replace(/\.$/, ""), 80);
  const targetGuess = inferEvolutionTarget(parsed.raw);
  const body = [
    `# ${desk.name} proposal — ${topic}`,
    "",
    "## Title",
    `Evolve ${targetGuess}: ${topic}`,
    "",
    "## Target desk",
    targetGuess,
    "",
    "## Change kind",
    inferChangeKind(parsed.raw),
    "",
    "## Hypothesis",
    `If we change how ${targetGuess} handles “${clip(parsed.firstSentence, 100)}”, the orchestrator spends less time rewriting desk output and the company moves forward without hiring.`,
    "",
    "## Change",
    parsed.raw,
    "",
    "## Success metric",
    `- Fewer returns on ${targetGuess} files for the same failure mode.`,
    `- One measurable hillclimb: same fixture, fewer tool calls or higher accept rate.`,
    `- Orchestrator review time per filed output drops.`,
    "",
    "## Rollback",
    `Revert this patch from evolution storage and re-run the desk smoke eval. If accept rate drops, kill the change.`,
    "",
    "## Patch text",
    buildDefaultPatch(targetGuess, parsed.raw, company),
    evolutionBlock
      ? `\nNote: ${company.name} already has accepted evolution on this desk. Extend, do not contradict, unless the brief says replace.`
      : "",
  ].join("\n");

  return {
    title: `Forge: ${clip(topic, 64)}`,
    body,
    kind: "proposal",
    steps: stepsFor(desk, [
      "Name the target desk",
      "State hypothesis and metric",
      "Write the patch",
      "Define rollback",
      "File for orchestrator accept",
    ]),
  };
}

function inferEvolutionTarget(text) {
  const lower = String(text).toLowerCase();
  for (const desk of DESKS) {
    if (desk.id === "forge") continue;
    if (lower.includes(desk.id) || lower.includes(desk.name.toLowerCase())) return desk.id;
  }
  if (/architecture|floor|hq|company/.test(lower)) return "company";
  if (/scout|research/.test(lower)) return "scout";
  if (/voice|copy|writing/.test(lower)) return "voice";
  return "all";
}

function inferChangeKind(text) {
  const lower = String(text).toLowerCase();
  if (/architecture|structure|layout|split|merge/.test(lower)) return "architecture";
  if (/tool|mcp|api|channel/.test(lower)) return "tool";
  if (/eval|test|fixture|hillclimb/.test(lower)) return "eval";
  if (/route|routing|auto-route/.test(lower)) return "routing";
  if (/playbook|template/.test(lower)) return "playbook";
  return "instructions";
}

function buildDefaultPatch(target, brief, company) {
  return [
    `Apply to: ${target}`,
    "",
    "Instructions delta:",
    `- When filing work for ${company.name}, treat the following as higher priority than default desk behavior.`,
    `- Brief context: ${clip(brief, 200)}`,
    "",
    "Architecture delta (if any):",
    `- Document which component moves: playbook, Agent SDK agent, HQ UI, or eval.`,
    `- One lever per hillclimb round; measure before/after on a pinned fixture.`,
    "",
    "Self-improvement rule:",
    `- Desks may propose changes via Forge or \`propose_evolution\`; orchestrator accept is required before apply.`,
  ].join("\n");
}

function promiseFrom(parsed, company) {
  const object = parsed.firstSentence.replace(
    /^(write|draft|research|build|specify|make|create|find|price|announce)\s+/i,
    "",
  );
  if (parsed.isQuestion) {
    return `${company.name} answers with a filed desk, not a chat.`;
  }
  return `You orchestrate. A desk files ${clip(object, 56)}.`;
}

function clip(text, n) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= n) return clean;
  return clean.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

export function foundingFiles(company) {
  const ctx = { company: normalizeCompany(company) };
  const scout = scoutPlaybook({
    desk: DESK_BY_ID.scout,
    parsed: parseBrief(
      "What is an AI-native company, and why should Flux.ai be one rather than a studio with extra chat windows?",
    ),
    ...ctx,
  });
  const maker = makerPlaybook({
    desk: DESK_BY_ID.maker,
    parsed: parseBrief(
      "Specify the Flux.ai HQ: the orchestrator floor where briefs become desk files.",
    ),
    ...ctx,
  });
  const voice = voicePlaybook({
    desk: DESK_BY_ID.voice,
    parsed: parseBrief("Write the manifesto and the one-line for Flux.ai."),
    ...ctx,
  });
  return [
    {
      id: "job_founding_scout",
      deskId: "scout",
      brief:
        "What is an AI-native company, and why should Flux.ai be one rather than a studio with extra chat windows?",
      status: "accepted",
      title: scout.title,
      body: scout.body,
      steps: scout.steps.map((step) => ({ ...step, done: true })),
      notes: "",
      seed: true,
    },
    {
      id: "job_founding_maker",
      deskId: "maker",
      brief: "Specify the Flux.ai HQ: the orchestrator floor where briefs become desk files.",
      status: "accepted",
      title: maker.title,
      body: maker.body,
      steps: maker.steps.map((step) => ({ ...step, done: true })),
      notes: "",
      seed: true,
    },
    {
      id: "job_founding_voice",
      deskId: "voice",
      brief: "Write the manifesto and the one-line for Flux.ai.",
      status: "accepted",
      title: voice.title,
      body: voice.body,
      steps: voice.steps.map((step) => ({ ...step, done: true })),
      notes: "",
      seed: true,
    },
  ];
}
