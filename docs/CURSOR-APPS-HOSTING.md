# Cursor Apps hosting (Flux landing)

Production hosting for the Flux landing site and chat API. This is not a product redesign.

## Production

| Item | Value |
| --- | --- |
| **Official production (only)** | `https://flux-ai-3cdd.apps.grok.bot` (slug `flux-ai-3cdd`) |
| Host | Cursor Apps (`apps.grok.bot`) |
| Framework | Static HTML + ES modules (no React/Next build) |
| Build command | `npm run build` (applies SQL migrations when `DATABASE_URL` is set) |
| Start (local) | `npm run dev` (API + static) or `npm start` (static only) |
| Chat backend | Groq via `GROQ_API_KEY` (server-side only) |
| Science data | PubChem + ChEBI/HMDB human-occurrence gate |

**One responsive build, all devices:** Desktop, tablet, and phone use the **same** HTML/CSS/JS from this repo. Layout adapts via CSS breakpoints (`landing.css` ≤900px drawer sidebar; `hq.css` ≤960px stacked floor). There is **no** separate mobile deploy or device-specific HTML.

**Republish path:** After merges to `main`, owner **republishes** the existing Cursor App `flux-ai-3cdd` from the dashboard (not automatic on every `git push`). That single publish updates every device at once.

**Not production** (do not bookmark, SEO, or agent-default these): `flux-ai.apps.grok.bot` (second Cursor slug), `https://deeksharatnabadoreea-2045.github.io/Flux.ai/` (GitHub Pages), `https://flux-ai-bio.netlify.app` (legacy Netlify). They can serve stale or divergent copies.

## Public chat (required for ordinary visitors)

Ordinary visitors must be able to open the site and use `/api/chat` **without** a Cursor account.

| Requirement | How |
| --- | --- |
| Visibility | App must be **Public** in Cursor Publish Settings (owner action). Private/team gates block the HTML before chat code runs. |
| API auth | `api/chat.js` uses optional `getIdentity` — anonymous OK; signed-in viewers get higher limits |
| Abuse controls | Same-origin Origin/Referer checks, **HMAC(trusted IP)** anonymous buckets (no UA/cookies), **`x-vercel-forwarded-for`** (Cursor Apps) or `x-forwarded-for` when platform sets headers, body/message limits, **mandatory Postgres** rate store when published |
| Secrets | Bind **`GROQ_API_KEY`** (Groq replies). Bind **`CHAT_SESSION_SECRET`** (required for published anonymous rate identity; optional `CHAT_ANON_RATE_SALT` instead). Bind app Postgres via **`DATABASE_URL`** (required in production — missing → **503** fail-closed). Never put keys in the browser. |

## GitHub is source only

The GitHub repository is the **source of truth for code**, not a second production host.

| Host | Role |
| --- | --- |
| `https://flux-ai-3cdd.apps.grok.bot` | **Production** (Cursor Apps) |
| `https://flux-ai.apps.grok.bot` | Obsolete second slug — **not production** |
| `https://deeksharatnabadoreea-2045.github.io/Flux.ai/` | GitHub Pages mirror — **not production** |
| `https://flux-ai-bio.netlify.app` | Legacy Netlify — **not production** |

**Deploy verification:** `index.html` and `hq.html` carry matching `flux-deploy-sha` / `flux-deploy-stamp` meta tags; the landing footer and HQ mast show the same **release ID** on every viewport. Static assets use `?v=<STATIC_CACHE_BUST>` from `js/deploy-revision.js`. `GET /api/chat` returns `deployStamp` / `publicChat: true`.

Do **not** point agents, SEO, or live inspect at GitHub Pages or Netlify. Do **not** disable Pages or change Netlify settings without Deeksharatna’s approval. Visibility must be **Public** for anonymous chat; that change is owner-controlled in Publish Settings.

## Cursor Apps (current)

| Piece | Path |
| --- | --- |
| Static site | `index.html`, `landing.css`, `js/*`, `hq.html`, … |
| Chat route | `api/chat.js` — public GET/POST with optional identity |
| Rate store | `js/chat-rate-store.mjs` + `migrations/001_chat_rate_limits.sql` (Postgres via `cursor-app.json`) |
| Anonymous identity | `js/chat-rate-identity.mjs` + `js/chat-security.mjs` (`CHAT_SESSION_SECRET` / `CHAT_ANON_RATE_SALT`) |
| Shared logic | `js/science-chat.mjs` |
| Secret | Bind **`GROQ_API_KEY`**; **`CHAT_SESSION_SECRET`** (or `CHAT_ANON_RATE_SALT`) for production anonymous rate buckets |
| Optional | `GROQ_MODEL` (defaults to `openai/gpt-oss-120b`); `CHAT_ALLOWED_ORIGINS` |

The browser only calls same-origin `POST /api/chat` with `credentials: "same-origin"`. It never receives the key.

## Local development

1. Set `GROQ_API_KEY` in the environment (or Cursor secrets for hosted runs).
2. **Published app:** bind `CHAT_SESSION_SECRET` (or `CHAT_ANON_RATE_SALT`) and ensure Postgres `DATABASE_URL` is bound for fail-closed rate limits.
3. Run `npm run dev` and open http://127.0.0.1:4173 — chat works without Cursor sign-in.
4. `npm test` and `npm run test:playwright` for automated coverage.

## Publish / update path

Cursor Apps does **not** auto-publish on every `git push`. Product path: cloud agent / Apps dashboard **publish** (or republish) of the **single canonical slug**; first publish and visibility changes wait for owner confirmation. Updates may republish when automatic updates are allowed — still not a GitHub Actions deploy of this site. Approved desktop changes reach mobile only when that same app is republished (one responsive build).

This repo has **no** custom `.github/workflows` deploy. GitHub’s built-in `pages-build-deployment` may refresh the github.io mirror when Pages is enabled; that mirror is not production.

## Legacy Netlify (not production)

`netlify.toml` and `netlify/functions/chat.mjs` remain in-repo for historical compatibility and unit tests (`js/netlify-chat.test.js`). They are **not** the current production host. Do not deploy Flux to Netlify for live traffic. Do not recommend Netlify as the hosting path.
