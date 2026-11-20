/**
 * Durable chat rate limits (Postgres when DATABASE_URL is set; Map fallback locally).
 * Also keeps a process-local Map as a fast path that mirrors durable writes.
 */
import { sql, usingDurableDatabase } from "./db.mjs";

/** @type {Map<string, { count: number, resetAt: number }>} */
const memory = new Map();

export const ANON_WINDOW_MS = 5 * 60 * 1000;
export const ANON_MAX_REQUESTS = 20;
export const ANON_DAILY_MAX = 80;
export const AUTH_WINDOW_MS = 5 * 60 * 1000;
export const AUTH_MAX_REQUESTS = 60;
export const AUTH_DAILY_MAX = 300;
export const IP_WINDOW_MS = 5 * 60 * 1000;
export const IP_MAX_REQUESTS = 40;

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** Test helper */
export function resetRateStoreMemory() {
  memory.clear();
}

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 */
async function consumeDurable(key, opts) {
  const now = Date.now();
  const resetAtIso = new Date(now + opts.windowMs).toISOString();
  const rows = await sql(
    `INSERT INTO chat_rate_buckets (bucket_key, count, reset_at, updated_at)
     VALUES ($1, 1, $2::timestamptz, now())
     ON CONFLICT (bucket_key) DO UPDATE SET
       count = CASE
         WHEN chat_rate_buckets.reset_at <= now() THEN 1
         ELSE chat_rate_buckets.count + 1
       END,
       reset_at = CASE
         WHEN chat_rate_buckets.reset_at <= now() THEN EXCLUDED.reset_at
         ELSE chat_rate_buckets.reset_at
       END,
       updated_at = now()
     RETURNING count, reset_at`,
    [key, resetAtIso],
  );
  const row = rows[0];
  const count = Number(row?.count ?? 1);
  const resetAt = new Date(row?.reset_at ?? resetAtIso).getTime();
  const allowed = count <= opts.limit;
  return {
    allowed,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    count,
  };
}

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 */
function consumeMemory(key, opts) {
  const now = Date.now();
  let bucket = memory.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + opts.windowMs };
    memory.set(key, bucket);
  }
  bucket.count += 1;
  const allowed = bucket.count <= opts.limit;
  return {
    allowed,
    remaining: Math.max(0, opts.limit - bucket.count),
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    count: bucket.count,
  };
}

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 */
export async function consumeRateLimit(key, opts) {
  const id = String(key || "anonymous").slice(0, 200);
  if (usingDurableDatabase()) {
    try {
      const durable = await consumeDurable(id, opts);
      // Mirror into memory for multi-check within the same isolate.
      memory.set(id, {
        count: durable.count,
        resetAt: Date.now() + (durable.retryAfterSec || opts.windowMs / 1000) * 1000,
      });
      return durable;
    } catch (err) {
      console.error("[chat-rate-store] durable_failed", String(err?.message ?? err).slice(0, 200));
      // Fail closed for abuse protection if durable store errors in production.
      if (process.env.CURSOR_APP_ID) {
        return { allowed: false, remaining: 0, retryAfterSec: 30, count: opts.limit + 1 };
      }
    }
  }
  return consumeMemory(id, opts);
}

/**
 * Apply visitor + IP (+ optional daily) limits. First failure wins.
 * @param {{
 *   visitorKey: string,
 *   ipKey: string,
 *   signedIn: boolean,
 * }} input
 */
export async function enforceChatRateLimits(input) {
  const windowLimit = input.signedIn
    ? { limit: AUTH_MAX_REQUESTS, windowMs: AUTH_WINDOW_MS }
    : { limit: ANON_MAX_REQUESTS, windowMs: ANON_WINDOW_MS };
  const dailyLimit = {
    limit: input.signedIn ? AUTH_DAILY_MAX : ANON_DAILY_MAX,
    windowMs: 24 * 60 * 60 * 1000,
  };

  const visitor = await consumeRateLimit(`v:${input.visitorKey}`, windowLimit);
  if (!visitor.allowed) {
    return { allowed: false, retryAfterSec: visitor.retryAfterSec, scope: "visitor" };
  }

  const ip = await consumeRateLimit(`ip:${input.ipKey}`, {
    limit: IP_MAX_REQUESTS,
    windowMs: IP_WINDOW_MS,
  });
  if (!ip.allowed) {
    return { allowed: false, retryAfterSec: ip.retryAfterSec, scope: "ip" };
  }

  const daily = await consumeRateLimit(`day:${dayKey()}:${input.visitorKey}`, dailyLimit);
  if (!daily.allowed) {
    return { allowed: false, retryAfterSec: daily.retryAfterSec, scope: "daily" };
  }

  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.min(visitor.remaining, ip.remaining, daily.remaining),
    scope: "ok",
  };
}
