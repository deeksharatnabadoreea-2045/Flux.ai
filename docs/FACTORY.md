# In-silico factory (build phase)

You are building the **factory**, not the monetization layer yet. Flux ingests trusted public data 24/7, stores snapshots locally, and uses desks to turn that into **real software architecture** for in-silico human trials.

## Principles

| Rule | Meaning |
| --- | --- |
| **Trusted ingest** | Committed catalog in `config/trusted-sources.json` plus orchestrator links in `config/linked-sources.json`. |
| **Keep the data** | Snapshots under `.flux/source-snapshots/` and ingest logs under `.flux/factory/` (local, gitignored). No premature product packaging. |
| **Build until it works** | Maker owns `engine/` specs and code paths; briefs should converge on runnable harnesses, not slide decks. |
| **Validator gate** | The **Validator** desk applies the **scientific method** ([SCIENTIFIC-METHOD.md](./SCIENTIFIC-METHOD.md)); `file_validator_report` rejects incomplete audits. Fake science → **block**. |
| **Orchestrator owns claims** | Voice and Wire stay honest; Validator files `block` / `fix` / `ship-with-caveats` style outcomes. |

## 24/7 loop

1. **Sync** — `company-dev` and Scout `source-sync` fetch trusted + linked URLs in parallel.
2. **Store** — JSON/HTML excerpts and manifest; append-only `ingest-log.jsonl`.
3. **Scout** — `source-watch` turns snapshots into research files when material appears.
4. **Maker** — Implements cohort schema, emulator interfaces, and harness stubs under `engine/`.
5. **Validator** — Audits proposals, code diffs, and science claims before you accept files or evolution.

## What to brief

- **Maker:** “Implement digital cohort v0 loader against latest ClinicalTrials API snapshot.”
- **Validator:** “Review Maker’s last file for overclaim vs L0–L3 ladder.”
- **Scout:** “Map competitor in-silico trial platforms from latest trusted ingest.”
- **Forge:** “Propose one architecture lever with metric + rollback.”

Monetization extraction is **intentionally deferred** — the factory only needs durable ingest and working engineering artifacts.

See also [LINKED-SOURCES.md](./LINKED-SOURCES.md), [PLATFORM-NORTH-STAR.md](./PLATFORM-NORTH-STAR.md), and `engine/README.md`.
