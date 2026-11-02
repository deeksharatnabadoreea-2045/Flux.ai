---
cron: "45 */4 * * *"
---

**Linked-source watch** — orchestrator websites (24/7 toward in-silico human trials).

1. Call `sync_linked_sources` if the manifest is older than 4 hours, otherwise call `read_linked_sources`.
2. Read excerpts in `.flux/source-snapshots/` for anything new toward digital cohorts, trial emulation, validation benchmarks, or regulatory paths.
3. If nothing material for in-silico trials, reply `PATROL_OK` and do **not** call `file_scout_report`.
4. If material, file a **Scout** report with section **Linked sources** listing URL, finding, and suggested next brief for Maker or Ledger.
