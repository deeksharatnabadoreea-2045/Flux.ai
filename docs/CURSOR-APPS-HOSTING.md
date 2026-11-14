# Cursor Apps hosting (Flux landing)

Hosting migration notes. This is not a product redesign.

## What this site is

| Item | Value |
| --- | --- |
| Framework | Static HTML + ES modules (no React/Next build) |
| Build command | None required for the landing; `npm test` for checks |
| Start (local) | `npm run dev` (API + static) or `npm start` (static only) |
| Chat backend | Groq via `GROQ_API_KEY` (server-side only) |
| Science data | PubChem + ChEBI/HMDB human-occurrence gate |

## Netlify (existing — keep until cutover)

| Piece | Path |
| --- | --- |
| Config | `netlify.toml` (publish `.`, functions, `/api/chat` redirect) |
| Function | `netlify/functions/chat.mjs` (same-origin + IP rate limit + payload validation) |
| Env | `GROQ_API_KEY` (and optional `GROQ_MODEL`) in Netlify UI; optional `CHAT_ALLOWED_ORIGINS` |

## Cursor Apps (new)

| Piece | Path |
| --- | --- |
| Static site | `index.html`, `landing.css`, `js/*`, `hq.html`, … |
| Chat route | `api/chat.js` — `export async function GET/POST(request)` |
| Shared logic | `js/science-chat.mjs` (same as Netlify / local) |
| Auth | Cursor sign-in via `requireIdentity` (private/team apps) |
| Rate limit | Per-viewer window in `js/chat-guard.mjs` (Cursor Apps + local HQ) |
| Secret | Bind **`GROQ_API_KEY`** in Cursor Apps / secure secrets |

The browser only calls same-origin `POST /api/chat`. It never receives the key. Netlify’s function stays for cutover but rejects cross-site / scripted calls without a matching browser Origin, rate-limits by IP, and validates payloads before Groq.

## Cutover checklist

1. Confirm `GROQ_API_KEY` is set in Cursor Apps secrets.
2. Publish as **private** (or team) first; test chat + molecule lookup.
3. Keep Netlify live until you approve the Cursor Apps deployment.
4. After approval, point DNS / stop Netlify if desired.
