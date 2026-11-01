# Scout — Flux.ai research desk (Agent SDK)

Scout is the first **live agent** behind the Flux.ai company floor. The orchestrator issues research briefs; Scout files a structured report with `file_scout_report`.

## Local commands

```bash
cd agents/scout
npm run check
npx @grok/agent-sdk@0.5.0 validate --dir .
npx @grok/agent-sdk@0.5.0 dev
```

Playground: http://127.0.0.1:3000/scout/playground (multi layout) or http://127.0.0.1:3000/playground in `--mode single`.

## Hook up to the HQ

From the repo root (same origin proxy):

```bash
export CURSOR_API_KEY=…   # or agent-sdk login
npm run dev
```

Open http://127.0.0.1:4173, set **Scout desk → Live agent**, and issue a research brief.

Without a Cursor credential, the HQ falls back to the Scout playbook automatically.

## Floor channel

`POST /v1/channels/floor/brief` (loopback only) accepts:

```json
{
  "brief": "Research …",
  "companyName": "Flux.ai",
  "mission": "…",
  "orchestrator": "Deeksharatna",
  "jobId": "optional-id-for-continuation"
}
```

Returns `{ ok, sessionId, playgroundUrl }`. Poll session events for `file_scout_report`.
