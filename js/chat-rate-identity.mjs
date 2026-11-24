/**
 * Anonymous rate-limit identity for public /api/chat (no cookies or visitor sessions).
 * HMAC(trusted platform IP) with server-only salt — never trusts visitor cookies or body fields.
 */
import { createHmac } from "node:crypto";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true, secret: string, source: string } | { ok: false, secret: null, source: string }}
 */
function resolveSessionSecretForSalt(env = process.env) {
  const explicit = String(env.CHAT_SESSION_SECRET ?? "").trim();
  if (explicit) {
    return { ok: true, secret: explicit, source: "CHAT_SESSION_SECRET" };
  }
  const appId = String(env.CURSOR_APP_ID ?? "").trim();
  if (appId) {
    return { ok: false, secret: null, source: "missing" };
  }
  return { ok: true, secret: "flux-local-dev-session-secret", source: "local" };
}

/**
 * Server-only salt for anonymous rate-limit identity (HMAC of trusted IP).
 * Published apps must bind CHAT_SESSION_SECRET or CHAT_ANON_RATE_SALT.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAnonRateSecret(env = process.env) {
  const explicitSalt = String(env.CHAT_ANON_RATE_SALT ?? "").trim();
  if (explicitSalt) {
    return { ok: true, secret: explicitSalt, source: "CHAT_ANON_RATE_SALT" };
  }
  const session = resolveSessionSecretForSalt(env);
  if (session.ok) {
    return { ok: true, secret: session.secret, source: session.source };
  }
  if (String(env.CURSOR_APP_ID ?? "").trim()) {
    return { ok: false, secret: null, source: "missing" };
  }
  return { ok: true, secret: "flux-local-dev-anon-rate-salt", source: "local" };
}

function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(name) ?? headers.get(name.toLowerCase()) ?? "").trim();
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v ?? "").trim();
  }
  return "";
}

/**
 * Stable anonymous id for rate limits — HMAC(trusted IP) only (no UA / cookies / body).
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function stableAnonymousVisitorId(request, opts = {}) {
  const env = opts.env ?? process.env;
  const ipKey = trustedClientKey(request, { env });
  const resolved = resolveAnonRateSecret(env);
  const salt = resolved.ok
    ? resolved.secret
    : String(env.CHAT_ANON_RATE_SALT ?? "flux-anon-rate-limit-v1");
  const rawIp = ipKey.startsWith("ip:") ? ipKey.slice(3) : ipKey;
  return createHmac("sha256", salt).update(rawIp).digest("hex").slice(0, 32);
}

/**
 * Postgres/memory visitor bucket key for anonymous chat.
 * Always uses stableAnonymousVisitorId (HMAC of trusted IP).
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {unknown} [_session] ignored — cookies do not affect buckets
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveAnonymousVisitorKey(request, _session, opts = {}) {
  return `anon:${stableAnonymousVisitorId(request, opts)}`;
}

/**
 * Platform-trusted client key for rate limiting. Never reads body fields.
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function trustedClientKey(request, opts = {}) {
  const env = opts.env ?? process.env;
  const headers = request.headers;

  const get = (name) => headerGet(headers, name);

  const nf = get("x-nf-client-connection-ip");
  if (nf) return `ip:${nf.slice(0, 128)}`;

  const onPlatform = Boolean(String(env.CURSOR_APP_ID ?? "").trim() || env.VERCEL);

  if (onPlatform) {
    const vercel = get("x-vercel-forwarded-for");
    if (vercel) {
      const first = vercel.split(",")[0]?.trim();
      if (first) return `ip:${first.slice(0, 128)}`;
    }
    const forwarded = get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return `ip:${first.slice(0, 128)}`;
    }
    const realIp = get("x-real-ip");
    if (realIp) return `ip:${realIp.slice(0, 128)}`;
  }

  return "ip:unknown";
}