# In-silico trial engine (v0)

Software goal: **emulate human trials in silico** with pre-registered endpoints, uncertainty, and validation against held-out registry/literature data.

This folder is the **working architecture**, not marketing copy. Desks file against these artifacts; Validator checks them against the validation ladder in `js/platform.js`.

## Layout

| Path | Purpose |
| --- | --- |
| `schemas/digital-cohort.v0.json` | JSON Schema for synthetic/real-world-derived cohort arms. |
| `schemas/trial-emulator.v0.json` | Protocol schedule, visits, arms, endpoint estimators. |
| `harness/` | Replay and concordance stubs toward L1 retrospective validation. |

## Build order (Maker)

1. Load cohort spec from schema-valid JSON.
2. Bind registry snapshot IDs from `.flux/source-snapshots/` (ClinicalTrials API pages).
3. Run harness stub to produce a structured “replay packet” (no efficacy claim until L1).
4. File definition of done + next code PR scope.

Validator must review each step before orchestrator accept.
