/**
 * Co-pilot grows as in-silico software becomes doable.
 * You build the engine; Flux ships the matching chat + desk powers.
 */

export const BUILD_PACT =
  "Founder builds feasibility; co-pilot gains features only when each stage is proven.";

/** @typedef {{ id: string, youBuild: string, copilotGets: string, desks: string[] }} RoadmapStage */

export const COPILOT_ROADMAP = [
  {
    id: "L0",
    youBuild: "Linked registries + clear questions (one disease, one outcome).",
    copilotGets: "Chat → Scout files trial landscape; 24/7 site watch.",
    desks: ["scout"],
    status: "live",
  },
  {
    id: "L1",
    youBuild: "Replay on finished trials: predicted vs known outcome.",
    copilotGets: 'Chat → “Did we get it right?” report on picked NCT IDs.',
    desks: ["scout", "ledger"],
    status: "next",
  },
  {
    id: "L2",
    youBuild: "Repeatable script/pipeline (same steps, new trial IDs).",
    copilotGets: "Chat → one-click back-test bundle; Maker files run log.",
    desks: ["maker", "ledger"],
    status: "planned",
  },
  {
    id: "L3",
    youBuild: "Uncertainty + pass/fail rules you trust.",
    copilotGets: "Chat → honest “go / wait / kill” with scorecard.",
    desks: ["ledger"],
    status: "planned",
  },
  {
    id: "L4",
    youBuild: "Shadow run beside a live trial (no replacement claim).",
    copilotGets: "Chat → parallel tracker for sponsors.",
    desks: ["scout", "maker", "ledger", "floor"],
    status: "planned",
  },
  {
    id: "L5",
    youBuild: "Regulatory-grade audit trail + validated engine slice.",
    copilotGets: "Premium tier: exportable evidence pack from chat.",
    desks: ["voice", "wire", "forge"],
    status: "planned",
  },
];

export function currentStage(roadmap = COPILOT_ROADMAP) {
  return roadmap.find((s) => s.status === "next") ?? roadmap[roadmap.length - 1];
}
