# Flux.ai

A company of one. You orchestrate. Agents do the jobs.

The site is the company floor. You issue a brief. A desk files the work. You accept it, return it, or kill it.

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

## Self-improvement and architecture

Agents may **propose** changes; they do not silently rewrite themselves.

1. Issue a brief to **Forge** (e.g. *Improve Scout so it cites sources we can verify*).
2. Forge files an **evolution proposal** with hypothesis, metric, patch, and rollback.
3. **Accept & apply evolution** — updates browser state and, with `npm run dev`, materializes to `.flux/evolution/` and `agents/scout/bot/evolution-appendix.md`.
4. Accepted patches are injected into desk playbooks and bound on the live Scout agent.

Live Scout can call `propose_evolution` during a turn; the orchestrator still accepts on the floor.

Hillclimb loop: measure → one lever → remeasure → lock with an eval (see `agents/scout` and Agent SDK evals).

## Run the floor

```bash
npm test
npm start          # static HQ only (playbook desks)
npm run dev        # HQ + Scout Agent SDK proxy (live Scout when credentialed)
```

Open http://127.0.0.1:4173

The floor stores company state in the browser. Reset founding files from the left rail if you want the original three accepted records back.

## Live agents and recursive self-improvement

Every desk (Scout, Maker, Voice, Floor, Ledger, Wire, Forge) has an Agent SDK project under [`agents/`](agents/). On the HQ left rail, pick **Live agent** per desk, or keep **Playbook** for instant files.

All desks include **recursive self-improvement**: playbooks document the loop; live agents expose `propose_evolution`. After a filed job, use **Start self-improvement cycle (Forge)** to propose a change, then **Accept & apply evolution** to materialize patches to every affected agent (`evolution-appendix.md`).

Run `npm run dev` with `CURSOR_API_KEY` (or `npx @grok/agent-sdk login`) for live agents.
