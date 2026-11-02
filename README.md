# Flux.ai

**North star:** [in-silico human trials](docs/PLATFORM-NORTH-STAR.md)—predict trial outcomes in software with validation strong enough to reduce or replace physical enrollment where regulators and data allow. Near–100% endpoint concordance is the long-term bar; it is earned with held-out evidence, not asserted in marketing.

**24/7 agents** are the runtime root. You orchestrate from the company floor; desk workers stay on duty (hosted or local pool), file work, and propose evolution — they never self-apply.

The site is the orchestrator console. You issue a brief. A desk files the work. You accept it, return it, or kill it.

## Desks

| Desk | Job | What it files |
| --- | --- | --- |
| Scout | Research | A map, the next finds, a go / wait / ignore |
| Maker | Product | Spec, build order, definition of done |
| Voice | Writing | Promise, homepage block, a public sentence |
| Floor | Operations | Checklist, cadence, failure mode |
| Ledger | Numbers | Unit of value, metrics, kill criteria |
| Wire | Outbound | The ask, the draft, when not to send |
| Forge | Evolution | Self-improvement and architecture proposals (accept to apply) |

The orchestrator does not take a desk’s chair. Judgment stays with you. Repetition goes to a desk.

## 24/7 runtime

| Layer | Role |
| --- | --- |
| **Hosted agents** | Production: deploy each desk from [`agents/`](agents/) — patrol schedules fire on Cursor hosting. See [`agents/HOSTING.md`](agents/HOSTING.md). |
| **`npm run dev`** | Local HQ + multi-agent pool on `:3000`, health at `/api/agents/health`. |
| **Playbooks** | Fallback when the pool is offline or a desk is set to offline mode on the floor. |

Every desk ships a **`patrol`** schedule (staggered every 6 hours UTC). Patrol turns default to quiet `PATROL_OK` unless memory shows open work.

## Self-improvement and architecture

Agents may **propose** changes; they do not silently rewrite themselves.

1. Issue a brief to **Forge** (e.g. *Improve Scout so it cites sources we can verify*).
2. Forge files an **evolution proposal** with hypothesis, metric, patch, and rollback.
3. **Accept & apply evolution** — updates browser state and, with `npm run dev`, materializes to `.flux/evolution/` and per-desk `evolution-appendix.md`.
4. Accepted patches bind on live agents and playbooks.

Hillclimb loop: measure → one lever → remeasure → lock with an eval (see `agents/*` and Agent SDK evals).

## Run the floor

```bash
npm test
npm run dev        # HQ + 24/7 agent pool (recommended)
npm start          # static HQ only — no live pool
```

Open http://127.0.0.1:4173

Desks default to **Live agent** in HQ. Use **Playbook** per desk only when you want offline files.

Run `npm run dev` with `CURSOR_API_KEY` (or `npx @grok/agent-sdk login`) for the local pool. Deploy hosted workers with `node scripts/deploy-all-desks.mjs` (see HOSTING.md).

**Linked websites:** add URLs on the HQ floor; Scout syncs them every 4 hours toward in-silico trial research ([docs/LINKED-SOURCES.md](docs/LINKED-SOURCES.md)).

The floor stores company state in the browser. Reset founding files from the left rail if you want the original three accepted records back.

## Recursive self-improvement

All desks include **recursive self-improvement**: live agents expose `propose_evolution`. After a filed job, use **Start self-improvement cycle (Forge)** to propose a change, then **Accept & apply evolution** to materialize patches for every affected agent.
