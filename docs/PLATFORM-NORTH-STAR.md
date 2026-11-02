# Platform north star — in-silico human trials

## Goal

Build software that can run **human trials in silico**—predicting outcomes on pre-specified endpoints for defined cohorts—so that most physical Phase I–III enrollment becomes unnecessary **only where validation proves it is safe to say so**.

The long-term aspiration is **near–100% concordance** with held-out physical trial results on primary endpoints for indications where the biology and data support modeling. That number is a **target to earn with evidence**, not a default claim.

## What “accurate enough” means here

| Requirement | Why |
| --- | --- |
| **Pre-registered endpoints** | Same primary/secondary definitions as a physical protocol. |
| **Held-out validation** | Retrospective and prospective shadow runs before replacement. |
| **Uncertainty** | Intervals and failure modes, not point-estimate bravado. |
| **Audit trail** | Data lineage, model version, and orchestrator approvals. |
| **Human gate** | You accept, return, or kill every file and every evolution patch. |

See `js/platform.js` for the **validation ladder** (L0–L3) encoded in the repo.

## Technical stack (to build)

Flux does not ship the simulation engine yet. The intended layers:

1. **Digital cohort** — inclusion/exclusion, baseline covariates, synthetic or real-world-derived arms.
2. **Mechanistic + ML hybrid** — PK/PD, disease progression, treatment response; trained and calibrated on public and licensed data.
3. **Trial emulator** — protocol schedule, visits, dropout, concomitant meds, endpoint estimators.
4. **Validation harness** — blind replay against ClinicalTrials.gov / publication results; concordance dashboards (Ledger desk metrics).
5. **Regulatory narrative** — when in-silico can support IND amendments, hybrid designs, or full substitution (Wire + Voice, human legal review).

## How Flux desks map today

24/7 agents are the **operating system** for building and governing the engine:

| Desk | Role in the trial stack |
| --- | --- |
| Scout | Literature, mechanisms, competitor trials, registry gaps |
| Maker | Pipelines, specs, simulation software, definition of done |
| Ledger | Endpoints, accuracy, calibration, kill criteria |
| Floor | Run cadence, data refresh, drift incidents |
| Voice | External language—no overclaim |
| Wire | Partners, CROs, data vendors, agencies |
| Forge | Model and architecture evolution (accept to apply) |

Briefs that mention simulation, in-silico, trials, or validation auto-route toward Maker, Ledger, or Scout via `js/desks.js`.

## Relationship to the company floor

- **HQ** = orchestrator console for briefs, files, and evolution accept.
- **Agents** = 24/7 workers that file structured outputs you approve.
- **North star** = what those files must eventually converge on—validated in-silico trials—not chat or generic “AI.”

Next concrete build steps (when you brief Maker): digital cohort schema, validation harness v0, and a single indication pilot with L1 retrospective replay.

## Linked websites (24/7)

Orchestrator-linked sites are synced on a schedule and analyzed by Scout for in-silico trial leads. See [LINKED-SOURCES.md](./LINKED-SOURCES.md).
