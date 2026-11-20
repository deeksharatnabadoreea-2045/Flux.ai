# Cursor Apps hosting (Flux landing)

Production hosting for the Flux landing site and chat API. This is not a product redesign.

## Production

| Item | Value |
| --- | --- |
| **Live URL** | `https://flux-ai.apps.grok.bot` |
| Slug | `flux-ai` |
| Host | Cursor Apps (`apps.grok.bot`) |
| Framework | Static HTML + ES modules (no React/Next build) |
| Build command | None required for the landing; `npm test` for checks |
| Start (local) | `npm run dev` (API + static) or `npm start` (static only) |
| Chat backend | Groq via `GROQ_API_KEY` (server-side only) |
| Science data | PubChem + ChEBI/HMDB human-occurrence gate |

Do **not** treat `https://flux-ai-bio.netlify.app` as production. That hostname may still resolve historically; it is obsolete for live inspect, SEO, and agent defaults.

## Cursor Apps (current)

| Piece | Path |
| --- | --- |
| Static site | `index.html`, `landing.css`, `js/*`, `hq.html`, … |
| Chat route | `api/chat.js` — `export async function GET/POST(request)` |
| Shared logic | `js/science-chat.mjs` (same as local / legacy Netlify function) |
| Auth | Cursor sign-in via `requireIdentity` (private/team apps) |
| Rate limit | Per-viewer window in `js/chat-guard.mjs` (Cursor Apps + local HQ) |
| Secret | Bind **`GROQ_API_KEY`** in Cursor Apps / secure secrets |
| Optional | `GROQ_MODEL` (defaults to `openai/gpt-oss-120b`); `CHAT_ALLOWED_ORIGINS` if you need extra browser origins |

The browser only calls same-origin `POST /api/chat`. It never receives the key.

## Local development

1. Set `GROQ_API_KEY` in the environment (or Cursor secrets for hosted runs).
2. Run `npm run dev` and open http://127.0.0.1:4173.
3. Chat health: authenticated `GET /api/chat` on Cursor Apps; local HQ serves the same route via the Node proxy.

## Legacy Netlify (not production)

`netlify.toml` and `netlify/functions/chat.mjs` remain in-repo for historical compatibility and unit tests (`js/netlify-chat.test.js`). They are **not** the current production host. Do not deploy Flux to Netlify for live traffic. Do not recommend Netlify as the hosting path.
