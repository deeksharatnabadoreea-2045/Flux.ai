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

The orchestrator does not take a desk’s chair. Judgment stays with you. Repetition goes to a desk.

## Run the floor

```bash
npm test
npm start          # static HQ only (playbook desks)
npm run dev        # HQ + Scout Agent SDK proxy (live Scout when credentialed)
```

Open http://127.0.0.1:4173

The floor stores company state in the browser. Reset founding files from the left rail if you want the original three accepted records back.

## Live Scout agent

Scout lives in [`agents/scout`](agents/scout). On the HQ left rail, set **Scout desk → Live agent**, then issue a research brief while `npm run dev` is running with `CURSOR_API_KEY` set (or after `npx @grok/agent-sdk login`). Other desks still use playbooks until you add agents the same way.
