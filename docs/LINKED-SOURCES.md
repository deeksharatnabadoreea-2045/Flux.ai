# Linked websites (24/7 source watch)

Flux stays connected to sites you care about while you sleep. **Scout** syncs them on a schedule and looks for material toward **in-silico human trials**.

## Add a site

1. Run `npm run dev` (fetch runs on the Node proxy, not on static Netlify alone).
2. On the HQ left rail, **Linked websites** → paste URL → **Link site**.
3. Click **Sync now** (or wait for the automatic sync every 4 hours).

Sites are stored in `config/linked-sources.json` (commit this file if hosted agents should see the same list).

Snapshots land in `.flux/source-snapshots/` (local only, gitignored).

## What runs 24/7

| Component | Cadence | Action |
| --- | --- | --- |
| `company-dev` | Every 4h + startup | HTTP fetch → snapshots |
| Scout `source-sync` schedule | `15 */4 * * *` UTC | `sync_linked_sources` tool |
| Scout `source-watch` schedule | `45 */4 * * *` UTC | Analyze snapshots; file Scout report if material |

Manual dev trigger:

```bash
curl -X POST http://127.0.0.1:3000/scout/v1/dev/schedules/source-sync
curl -X POST http://127.0.0.1:3000/scout/v1/dev/schedules/source-watch
npm run sources:sync
```

## Hosted Scout deploy

Add each linked hostname to Scout `hosting.egressDomains` in `agents/scout/bot/agent.ts` before deploy (or use your team’s domain allowlist policy). Without egress, hosted sync cannot reach the site.

Generate hostnames from config:

```bash
node scripts/print-scout-egress.mjs
```

## Send links in chat

When you paste URLs here in Cursor, they are **not** automatically added to Flux. Link them on the HQ floor (or edit `config/linked-sources.json`) so Scout’s 24/7 loop can use them.
