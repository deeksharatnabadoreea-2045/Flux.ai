import { DESK_BY_ID } from "./desks.js";

export function recursiveImprovementBlock(desk) {
  const name = desk?.name ?? "this desk";
  return [
    "## Recursive self-improvement",
    "",
    "Every agent at Flux.ai can evolve in a loop:",
    "",
    "1. **File** work for the orchestrator.",
    "2. **Measure** against the success metric in the file.",
    "3. If the metric misses, **propose** one change (instructions, tool, eval, routing, or architecture).",
    "4. Orchestrator **accepts & applies** via Forge — or `propose_evolution` on a live agent.",
    "5. **Re-run** the same brief with accepted patches; repeat until accept rate holds or you kill the line.",
    "",
    `Live ${name}: call \`propose_evolution\` with hypothesis, metric, patch, and rollback.`,
    `Playbook ${name}: issue a Forge brief targeting \`${desk?.id ?? "desk"}\` with the failure mode.`,
    "",
    "Never apply self-changes without orchestrator accept. One lever per hillclimb round.",
  ].join("\n");
}

export function recursiveStepLabel() {
  return "Plan evolution if the metric misses";
}

export function buildForgeBriefFromJob(job, company) {
  const desk = DESK_BY_ID[job.deskId];
  return [
    `Recursive self-improvement for ${desk?.name ?? job.deskId} after filed work: "${job.title}".`,
    "",
    `Original brief: ${job.brief}`,
    "",
    `Company: ${company.name}. Propose one lever (patch + metric + rollback) so the next file needs fewer returns.`,
  ].join("\n");
}

export function shouldOfferRecursiveCycle(agents, deskId, job) {
  if (!job || job.kind === "proposal" || deskId === "forge") return false;
  if (job.status !== "filed" && job.status !== "accepted" && job.status !== "returned") return false;
  return agents?.[deskId]?.recursive !== false;
}
