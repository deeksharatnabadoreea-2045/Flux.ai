# 24/7 desk agents (Flux runtime root)

**Website design reference / recommended production:** [https://flux-ai-3cdd.apps.grok.bot](https://flux-ai-3cdd.apps.grok.bot) (Cursor Apps). A second publish at [https://flux-ai.apps.grok.bot](https://flux-ai.apps.grok.bot) must not be treated as a parallel product — consolidate to one slug after owner confirmation. Desk agents and live-site inspect/test must use the design-reference URL until then — not GitHub Pages (`*.github.io`) and not the legacy Netlify hostname. GitHub is source only; there is no separate mobile deploy.

Flux.ai is built around **always-on Agent SDK workers**, not static playbooks. The HQ floor is the orchestrator console; each desk is a deployable agent with:

- **Floor channel** — orchestrator briefs (`POST …/v1/channels/floor/brief`)
- **`patrol` schedule** — staggered every 6h UTC on Cursor hosting (quiet when idle)
- **Recursive self-improvement** — `propose_evolution` + Forge; you accept before apply

Playbooks in `js/desks.js` remain for offline demos and when the pool has no Cursor credential.

## Local pool (development)

```bash
npm run dev
# HQ http://127.0.0.1:4173 — health at /api/agents/health
# Multi-agent pool http://127.0.0.1:3000/{desk}/…
```

Each desk is a **separate hosted worker**. Patrol schedules fire **in parallel** (same UTC cron on every desk). Briefs to different desks run concurrently; use HQ **All live desks (parallel)** or `POST /api/briefs/parallel` to fan one brief out.

Patrol schedules do **not** auto-fire under `serve --dev`. Trigger one manually:

```bash
curl -X POST "http://127.0.0.1:3000/scout/v1/dev/schedules/patrol"
```

## Hosted deploy (production 24/7)

Deploy **each desk** from a pushed git ref (one Agent SDK project per folder):

```bash
SOURCE_REF="$(git rev-parse HEAD)"
for desk in scout maker voice floor ledger validator wire forge; do
  npx --yes @grok/agent-sdk@0.5.0 validate --dir "agents/$desk"
  npx --yes @grok/agent-sdk@0.5.0 deploy --dir "agents/$desk" --ref "$SOURCE_REF"
done
```

Use a Cursor service account (`CURSOR_SERVICE_ACCOUNT_KEY`) in CI or a secure environment — see Agent SDK deploy docs. After deploy, schedules in `bot/schedules/patrol.md` run on the host cadence.

Regenerate patrol files after template changes:

```bash
node scripts/sync-desk-heartbeats.mjs
```

Validate everything:

```bash
npm run agents:validate
```
