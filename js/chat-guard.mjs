/**
 * Server-side chat guards for Cursor Apps (auth helpers + rate limits).
 * Does not change Netlify Function source; used by api/chat.js and local HQ.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 30;
const buckets = new Map();

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
