/** Long-term product north star — shared by HQ, playbooks, and agent briefs. */

export const NORTH_STAR = {
  headline: "In-silico human trials",
  target:
    "Software that predicts human trial outcomes without enrolling physical participants, with accuracy high enough to drive go/no-go and label decisions—validated against held-out clinical data and regulator-aligned evidence standards.",
  aspirationAccuracy:
    "Near–100% concordance on pre-specified primary endpoints for well-modeled indications; never claimed without published validation metrics.",
  orchestratorRole:
    "Humans hold approval for trial design, model releases, and any claim that substitutes for a physical study.",
};

export const VALIDATION_LADDER = [
  {
    stage: "L0 — Mechanistic",
    bar: "Biology and PK/PD plausibility; no efficacy claim.",
  },
  {
    stage: "L1 — Retrospective",
    bar: "Blind replay on completed trials; pre-registered endpoints and cohort rules.",
  },
  {
    stage: "L2 — Prospective shadow",
    bar: "Run in parallel with physical trials; measure concordance before any replacement claim.",
  },
  {
    stage: "L3 — Regulatory-grade",
    bar: "Documented QMS, audit trail, uncertainty quantification, and agency-aligned submission path.",
  },
];

/** How existing Flux desks map to the in-silico trial stack (no new runtime yet). */
export const DESK_ROLES_IN_TRIAL_STACK = {
  scout: "Evidence, mechanisms, competitor trials, and what to verify in literature and registries.",
  maker: "Simulation pipeline, digital cohort spec, software architecture, and definition of done.",
  ledger: "Endpoints, accuracy metrics, calibration, kill criteria, and when in-silico is not yet defensible.",
  floor: "Ops cadence for model runs, data refresh, and incident response when predictions drift.",
  voice: "External claims, investor/regulator-facing language—no overclaim on accuracy.",
  wire: "Partners, CROs, data vendors, and agencies—the ask and the follow-up.",
  forge: "Evolution of models and architecture—always orchestrator-accept before apply.",
};

export const FOUNDING_MISSION = `${NORTH_STAR.headline}. ${NORTH_STAR.target} ${NORTH_STAR.orchestratorRole}`;
