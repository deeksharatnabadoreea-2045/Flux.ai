/**
 * Production preflight for anonymous /api/chat POST (Cursor Apps).
 * Enforces fail-closed posture before rate limits or upstream calls.
 */
import { usingDurableDatabase } from "./db.mjs";
import { resolveAnonRateSecret, trustedClientKey } from "./chat-rate-identity.mjs";

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isPublishedChatApp(env = process.env) {
  return Boolean(String(env.CURSOR_APP_ID ?? "").trim());
}

/**
 * Anonymous POST preflight on published apps: HMAC salt, trusted IP, Postgres rate store.
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv, signedIn?: boolean }} [opts]
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function preflightAnonymousChatPost(request, opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.signedIn || !isPublishedChatApp(env)) {
    return { ok: true };
  }

  const rateSecret = resolveAnonRateSecret(env);
  if (!rateSecret.ok) {
    return { ok: false, status: 503, error: "chat_rate_secret_missing" };
  }

  const ipKey = trustedClientKey(request, { env });
  if (ipKey === "ip:unknown") {
    return { ok: false, status: 503, error: "client_ip_unavailable" };
  }

  if (!usingDurableDatabase()) {
    return { ok: false, status: 503, error: "rate_store_unavailable" };
  }

  return { ok: true };
}