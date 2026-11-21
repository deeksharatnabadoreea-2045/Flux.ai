/**
 * Anonymous visitor sessions + trusted client IP for public chat rate limits.
 * Cookie is HMAC-signed with CHAT_SESSION_SECRET (server-only). Never trust
 * client-supplied identity fields or raw IP headers unless the platform set them.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const VISITOR_COOKIE = "flux_vid";
const MAX_COOKIE_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true, secret: string, source: string } | { ok: false, secret: null, source: string }}
 */
export function resolveSessionSecret(env = process.env) {
  const explicit = String(env.CHAT_SESSION_SECRET ?? "").trim();
  if (explicit) {
    return { ok: true, secret: explicit, source: "CHAT_SESSION_SECRET" };
  }
  const appId = String(env.CURSOR_APP_ID ?? "").trim();
  if (appId) {
    // Published apps must bind CHAT_SESSION_SECRET — no derive-from-app-id fallback.
    return { ok: false, secret: null, source: "missing" };
  }
  return { ok: true, secret: "flux-local-dev-session-secret", source: "local" };
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
 * Stable anonymous id for rate limits when no valid flux_vid cookie (IP + UA).
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function stableAnonymousVisitorId(request, opts = {}) {
  const env = opts.env ?? process.env;
  const ipKey = trustedClientKey(request, { env });
  const ua = headerGet(request.headers, "user-agent").slice(0, 256);
  const resolved = resolveSessionSecret(env);
  const salt = resolved.ok
    ? resolved.secret
    : String(env.CHAT_ANON_RATE_SALT ?? "flux-anon-rate-limit-v1");
  return createHmac("sha256", salt).update(`${ipKey}|${ua}`).digest("hex").slice(0, 32);
}

/**
 * Postgres/memory visitor bucket key for anonymous chat.
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ visitorId: string, minted: boolean }} session
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveAnonymousVisitorKey(request, session, opts = {}) {
  if (!session.minted) {
    return `anon:${session.visitorId}`;
  }
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

  const get = (name) => {
    if (!headers) return "";
    if (typeof headers.get === "function") {
      return String(headers.get(name) ?? headers.get(name.toLowerCase()) ?? "").trim();
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === lower) return String(v ?? "").trim();
    }
    return "";
  };

  // Netlify edge IP (legacy / tests).
  const nf = get("x-nf-client-connection-ip");
  if (nf) return `ip:${nf.slice(0, 128)}`;

  // Cursor Apps / Vercel-style platforms set forwarding headers themselves.
  // Only trust them when we know we are on the published host or Netlify.
  const onPlatform = Boolean(String(env.CURSOR_APP_ID ?? "").trim() || env.NETLIFY || env.VERCEL);

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

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @param {string | null | undefined} cookieHeader
 * @param {string} name
 */
export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return "";
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

/**
 * @param {string} raw
 * @param {string} secret
 * @returns {{ ok: true, visitorId: string } | { ok: false }}
 */
export function verifyVisitorToken(raw, secret) {
  const token = String(raw || "");
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  const [id, ts, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false };
  const issued = Number(ts);
  if (!Number.isFinite(issued)) return { ok: false };
  const ageSec = (Date.now() - issued) / 1000;
  if (ageSec < 0 || ageSec > MAX_COOKIE_AGE_SEC) return { ok: false };
  const expected = sign(`${id}.${ts}`, secret);
  if (!safeEqual(sig, expected)) return { ok: false };
  return { ok: true, visitorId: id.toLowerCase() };
}

/**
 * @param {string} visitorId
 * @param {string} secret
 */
export function mintVisitorToken(visitorId, secret) {
  const ts = String(Date.now());
  const id = visitorId || randomUUID();
  const sig = sign(`${id}.${ts}`, secret);
  return { visitorId: id, token: `${id}.${ts}.${sig}` };
}

/**
 * @param {string} token
 * @param {{ secure?: boolean, maxAgeSec?: number }} [opts]
 */
export function visitorSetCookieHeader(token, opts = {}) {
  const maxAge = opts.maxAgeSec ?? MAX_COOKIE_AGE_SEC;
  const secure = opts.secure === true ? "; Secure" : "";
  return `${VISITOR_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * Resolve or mint a visitor id from the request cookies.
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv, secureCookie?: boolean }} [opts]
 */
export function ensureVisitorSession(request, opts = {}) {
  const env = opts.env ?? process.env;
  const resolved = resolveSessionSecret(env);
  const headers = request.headers;
  const cookieHeader =
    typeof headers.get === "function"
      ? headers.get("cookie")
      : headers?.cookie ?? headers?.Cookie ?? "";

  if (!resolved.ok) {
    return {
      visitorId: stableAnonymousVisitorId(request, { env }),
      setCookie: null,
      minted: true,
    };
  }

  const secret = resolved.secret;
  const existing = readCookie(cookieHeader, VISITOR_COOKIE);
  const verified = verifyVisitorToken(existing, secret);
  if (verified.ok) {
    return {
      visitorId: verified.visitorId,
      setCookie: null,
      minted: false,
    };
  }

  const minted = mintVisitorToken(randomUUID(), secret);
  const secure =
    opts.secureCookie ??
    Boolean(String(env.CURSOR_APP_ID ?? "").trim() || env.VERCEL || env.NETLIFY);
  return {
    visitorId: minted.visitorId,
    setCookie: visitorSetCookieHeader(minted.token, { secure }),
    minted: true,
  };
}
