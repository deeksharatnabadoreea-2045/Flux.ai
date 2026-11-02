# Flux.ai desk agents (24/7 root)

Flux runs on **always-on** Agent SDK workers. HQ is the orchestrator UI; these folders are the production runtime. See [HOSTING.md](./HOSTING.md) for deploy and patrol schedules.

Each desk has an **Agent SDK** project with:

- `file_<desk>_report` — file work for orchestrator review
- `propose_evolution` — recursive self-improvement proposal (orchestrator accept required)
- `self-improve` skill — hillclimb workflow
- `bot/schedules/patrol.md` — 24/7 patrol (hosted cron; manual under `serve --dev`)
- `evolution-appendix.md` — generated when you accept evolution on the floor (`npm run dev`)

| Desk | Folder | Port (multi serve) |
| --- | --- | --- |
| Scout | `scout/` | `:3000/scout` |
| Maker | `maker/` | `:3000/maker` |
| Voice | `voice/` | `:3000/voice` |
| Floor | `floor/` | `:3000/floor` |
| Ledger | `ledger/` | `:3000/ledger` |
| Wire | `wire/` | `:3000/wire` |
| Forge | `forge/` | `:3000/forge` |

## Setup

```bash
cd agents/scout && npm install   # repeat per desk you run live, or install each
npm run dev                      # from repo root — multi-agent pool on :3000
```

Scaffold missing desks: `node scripts/scaffold-desk-agents.mjs`

## Recursive loop

Measure → propose one lever → orchestrator accept → materialize → re-run brief → eval lock.
