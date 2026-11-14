/**
 * Server-side chat guards: rate limits, payload validation, same-origin checks.
 * Used by Cursor Apps (`api/chat.js`), Netlify (`netlify/functions/chat.mjs`), and local HQ.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 30;
const buckets = new Map();

export const MAX_CHAT_BODY_BYTES = 32_768;
export const MAX_CHAT_MESSAGES = 24;
export const MAX_CHAT_CONTENT_CHARS = 4_000;
export const MAX_CONVERSATION_ID_CHARS = 128;

/**
 * Sliding fixed-window rate limit keyed by viewer id (or anonymous IP fallback).
 * @param {string} key
 * @param {{ limit?: number, windowMs?: number }} [opts]
 * @returns {{ allowed: boolean, retryAfterSec: number, remaining: number }}
 */
export function checkChatRateLimit(key, opts = {}) {
  const limit = opts.limit ?? MAX_REQUESTS;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const id = String(key || "anonymous").slice(0, 200);
  const now = Date.now();

  let bucket = buckets.get(id);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(id, bucket);
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.max(0, limit - bucket.count),
  };
}

/** Test helper — clear in-memory buckets. */
export function resetChatRateLimits() {
  buckets.clear();
}

/**
 * Strip provider error details so clients never see raw Groq/API payloads.
 * @param {unknown} err
 */
export function safeChatProviderError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  // Log-friendly server detail stays out of the client reply.
  if (/groq|openai|api key|unauthorized|429|quota|rate/i.test(raw)) {
    return "The AI provider is temporarily unavailable. Try again shortly.";
  }
  return "Chat could not complete. Try again.";
}

/**
 * Client key for anonymous rate limiting (Netlify / edge).
 * Prefers platform IP headers; never trusts user-controlled body fields.
 * @param {Record<string, string | undefined> | Headers | null | undefined} headers
 */
export function clientKeyFromHeaders(headers) {
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

  const nf = get("x-nf-client-connection-ip");
  if (nf) return `ip:${nf.slice(0, 128)}`;

  const forwarded = get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return `ip:${first.slice(0, 128)}`;
  }

  const realIp = get("x-real-ip");
  if (realIp) return `ip:${realIp.slice(0, 128)}`;

  return "ip:unknown";
}

/**
 * Extra origins allowed beyond same-host (comma-separated CHAT_ALLOWED_ORIGINS).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseAllowedChatOrigins(env = process.env) {
  const raw = String(env.CHAT_ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 32);
}

/**
 * Accept browser same-origin chat (Origin/Referer host matches Host) or an allowlisted origin.
 * Rejects cross-site and raw scripted calls with no Origin/Referer — those are the abuse path.
 * @param {Record<string, string | undefined> | Headers | null | undefined} headers
 * @param {{ allowedOrigins?: string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function assertChatBrowserOrigin(headers, opts = {}) {
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

  const host = get("host") || get("x-forwarded-host");
  const origin = get("origin");
  const referer = get("referer");
  const allowed = new Set([
    ...(opts.allowedOrigins ?? []),
    ...parseAllowedChatOrigins(opts.env ?? process.env),
  ]);

  const hostMatches = (urlString) => {
    try {
      const u = new URL(urlString);
      if (!host) return false;
      // Host may include port; URL.host includes port when non-default.
      return u.host === host || u.hostname === host.split(":")[0];
    } catch {
      return false;
    }
  };

  if (origin) {
    if (allowed.has(origin) || hostMatches(origin)) return { ok: true };
    return { ok: false, error: "origin_forbidden" };
  }

  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (allowed.has(refOrigin) || hostMatches(referer)) return { ok: true };
    } catch {
      /* fall through */
    }
    return { ok: false, error: "origin_forbidden" };
  }

  return { ok: false, error: "origin_required" };
}

/**
 * Validate chat JSON body before calling Groq / PubChem.
 * @param {unknown} payload
 * @param {{ maxMessages?: number, maxContentChars?: number }} [opts]
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateChatPayload(payload, opts = {}) {
  const maxMessages = opts.maxMessages ?? MAX_CHAT_MESSAGES;
  const maxContentChars = opts.maxContentChars ?? MAX_CHAT_CONTENT_CHARS;

  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid_payload" };
  }

  const body = /** @type {Record<string, unknown>} */ (payload);
  const keys = Object.keys(body);
  if (keys.length > 8) {
    return { ok: false, error: "invalid_payload" };
  }

  if (body.conversationId != null) {
    const id = String(body.conversationId);
    if (id.length > MAX_CONVERSATION_ID_CHARS) {
      return { ok: false, error: "conversation_id_too_long" };
    }
  }

  if (body.message != null) {
    if (typeof body.message !== "string") {
      return { ok: false, error: "invalid_message" };
    }
    if (body.message.length > maxContentChars) {
      return { ok: false, error: "message_too_long" };
    }
  }

  if (body.messages != null) {
    if (!Array.isArray(body.messages)) {
      return { ok: false, error: "invalid_messages" };
    }
    if (body.messages.length > maxMessages) {
      return { ok: false, error: "too_many_messages" };
    }
    for (const item of body.messages) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: "invalid_messages" };
      }
      const role = item.role;
      if (role != null && role !== "user" && role !== "assistant" && role !== "system") {
        return { ok: false, error: "invalid_messages" };
      }
      const content = item.content;
      if (content != null && typeof content !== "string") {
        return { ok: false, error: "invalid_messages" };
      }
      if (typeof content === "string" && content.length > maxContentChars) {
        return { ok: false, error: "message_too_long" };
      }
    }
  }

  const hasMessage =
    (typeof body.message === "string" && body.message.trim()) ||
    (Array.isArray(body.messages) &&
      body.messages.some((m) => typeof m?.content === "string" && m.content.trim()));

  if (!hasMessage) {
    return { ok: false, error: "message_required" };
  }

  return {
    ok: true,
    value: {
      conversationId: body.conversationId != null ? String(body.conversationId) : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      messages: Array.isArray(body.messages)
        ? body.messages.map((m) => ({
            role: m?.role === "assistant" ? "assistant" : m?.role === "system" ? "system" : "user",
            content: String(m?.content ?? ""),
          }))
        : undefined,
    },
  };
}
