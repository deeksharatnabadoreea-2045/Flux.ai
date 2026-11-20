# Cursor Apps hosting (Flux landing)

Production hosting for the Flux landing site and chat API. This is not a product redesign.

## Production

| Item | Value |
| --- | --- |
| **Design reference (until owner picks otherwise)** | `https://flux-ai-3cdd.apps.grok.bot` (slug `flux-ai-3cdd`) |
| **Also live (do not treat as a second product)** | `https://flux-ai.apps.grok.bot` (slug `flux-ai`) |
| Host | Cursor Apps (`apps.grok.bot`) |
| Framework | Static HTML + ES modules (no React/Next build) |
| Build command | `npm run build` (applies SQL migrations when `DATABASE_URL` is set) |
| Start (local) | `npm run dev` (API + static) or `npm start` (static only) |
| Chat backend | Groq via `GROQ_API_KEY` (server-side only) |
| Science data | PubChem + ChEBI/HMDB human-occurrence gate |

**Dual deployment:** `flux-ai-3cdd` and `flux-ai` are **separate** Cursor Apps publishes of this same repo folder. Desktop and mobile for a given slug share one build (responsive CSS — no separate mobile site). Pick **one** slug as canonical production, republish only that slug, and stop using the other. Prefer consolidating on `flux-ai-3cdd` (design source of truth) unless the owner explicitly chooses `flux-ai` after confirming UI parity. Do not create a third app.

Do **not** treat `https://flux-ai-bio.netlify.app` as production. That hostname may still resolve historically; it is obsolete for live inspect, SEO, and agent defaults.

## Public chat (required for ordinary visitors)

Ordinary visitors must be able to open the site and use `/api/chat` **without** a Cursor account.

| Requirement | How |
| --- | --- |
| Visibility | App must be **Public** in Cursor Publish Settings (owner action). Private/team gates block the HTML before chat code runs. |
| API auth | `api/chat.js` uses optional `getIdentity` — anonymous OK; signed-in viewers get higher limits |
| Abuse controls | Same-origin Origin/Referer checks, signed `flux_vid` visitor cookie, trusted platform IP key, body/message limits, durable Postgres rate buckets when `DATABASE_URL` is set |
| Secrets | Bind **`GROQ_API_KEY`** (required for Groq replies). Bind **`CHAT_SESSION_SECRET`** for visitor cookie HMAC (recommended). Never put keys in the browser. |

## GitHub is source only

The GitHub repository is the **source of truth for code**, not a second production host.

| Host | Role |
| --- | --- |
| `https://flux-ai-3cdd.apps.grok.bot` | **Design reference** / recommended single production (Cursor Apps) |
| `https://flux-ai.apps.grok.bot` | Second Cursor Apps publish — consolidate away after owner pick |
| `https://deeksharatnabadoreea-2045.github.io/Flux.ai/` | GitHub Pages static mirror — **not production** |
| `https://flux-ai-bio.netlify.app` | Legacy Netlify — **not production** |

There is **no** separate mobile deploy URL. For whichever slug is canonical, desktop and mobile use that same Cursor Apps origin; layout adapts via CSS (`landing.css` breakpoints, e.g. `@media (max-width: 900px)`).

**Deploy verification:** `index.html` carries `flux-deploy-sha` / `flux-deploy-stamp`; `GET /api/chat` returns `deployStamp` / `publicChat: true`.

Do **not** point agents, SEO, or live inspect at GitHub Pages or Netlify. Do **not** disable Pages or change Netlify settings without Deeksharatna’s approval. Visibility must be **Public** for anonymous chat; that change is owner-controlled in Publish Settings.

## Cursor Apps (current)

| Piece | Path |
| --- | --- |
| Static site | `index.html`, `landing.css`, `js/*`, `hq.html`, … |
| Chat route | `api/chat.js` — public GET/POST with optional identity |
| Rate store | `js/chat-rate-store.mjs` + `migrations/001_chat_rate_limits.sql` (Postgres via `cursor-app.json`) |
| Visitor sessions | `js/chat-visitor.mjs` (`CHAT_SESSION_SECRET`) |
| Shared logic | `js/science-chat.mjs` |
| Secret | Bind **`GROQ_API_KEY`**; bind **`CHAT_SESSION_SECRET`** |
| Optional | `GROQ_MODEL` (defaults to `openai/gpt-oss-120b`); `CHAT_ALLOWED_ORIGINS` |

The browser only calls same-origin `POST /api/chat` with `credentials: "same-origin"`. It never receives the key.

## Local development

1. Set `GROQ_API_KEY` in the environment (or Cursor secrets for hosted runs).
2. Optional: `CHAT_SESSION_SECRET` for stable visitor cookies.
3. Run `npm run dev` and open http://127.0.0.1:4173 — chat works without Cursor sign-in.
4. `npm test` and `npm run test:playwright` for automated coverage.

## Publish / update path

Cursor Apps does **not** auto-publish on every `git push`. Product path: cloud agent / Apps dashboard **publish** (or republish) of the **single canonical slug**; first publish and visibility changes wait for owner confirmation. Updates may republish when automatic updates are allowed — still not a GitHub Actions deploy of this site. Approved desktop changes reach mobile only when that same app is republished (one responsive build).

This repo has **no** custom `.github/workflows` deploy. GitHub’s built-in `pages-build-deployment` may refresh the github.io mirror when Pages is enabled; that mirror is not production.

## Legacy Netlify (not production)

`netlify.toml` and `netlify/functions/chat.mjs` remain in-repo for historical compatibility and unit tests (`js/netlify-chat.test.js`). They are **not** the current production host. Do not deploy Flux to Netlify for live traffic. Do not recommend Netlify as the hosting path.
