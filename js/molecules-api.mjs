/**
 * Shared guards for public molecule explorer APIs (search/profile/structure/featured).
 * Rate-limits by trusted client IP, validates inputs, keeps explorer anonymous.
 */
import { checkChatRateLimit, clientKeyFromHeaders } from "./chat-guard.mjs";
import { trustedClientKey } from "./chat-rate-identity.mjs";

/** Sliding window for PubChem-proxied molecule GETs (per IP). */
export const MOLECULE_WINDOW_MS = 5 * 60 * 1000;
/** Max molecule API requests per IP per window (all routes share one budget). */
export const MOLECULE_MAX_REQUESTS = 60;
/** Max search query length (also enforced in route handlers). */
export const MOLECULE_MAX_QUERY_CHARS = 120;

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const responseCache = new Map();

/**
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function moleculeClientKey(request, opts = {}) {
  const env = opts.env ?? process.env;
  const trusted = trustedClientKey(request, { env });
  if (trusted && trusted !== "ip:unknown") return trusted;
  return clientKeyFromHeaders(request.headers);
}

/**
 * @param {Request | { headers: Headers | Record<string, string | undefined> }} request
 * @param {{ env?: NodeJS.ProcessEnv, limit?: number, windowMs?: number }} [opts]
 * @returns {{ allowed: true, remaining: number } | { allowed: false, retryAfterSec: number, remaining: 0 }}
 */
export function enforceMoleculeRateLimit(request, opts = {}) {
  const key = `mol:${moleculeClientKey(request, opts)}`;
  const result = checkChatRateLimit(key, {
    limit: opts.limit ?? MOLECULE_MAX_REQUESTS,
    windowMs: opts.windowMs ?? MOLECULE_WINDOW_MS,
  });
  if (!result.allowed) {
    return {
      allowed: false,
      retryAfterSec: result.retryAfterSec,
      remaining: 0,
    };
  }
  return { allowed: true, remaining: result.remaining };
}

/**
 * @param {Request} request
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Response | null} rate-limit Response, or null if allowed
 */
export function moleculeRateLimitResponse(request, opts = {}) {
  const rate = enforceMoleculeRateLimit(request, opts);
  if (rate.allowed) return null;
  return Response.json(
    {
      error: "rate_limited",
      retryAfterSec: rate.retryAfterSec,
      results: [],
    },
    {
      status: 429,
      headers: {
        "cache-control": "private, no-store",
        "retry-after": String(rate.retryAfterSec),
      },
    },
  );
}

/**
 * Short TTL in-process cache for identical molecule GETs (cuts PubChem fan-out).
 * @param {string} cacheKey
 * @param {number} ttlMs
 * @param {() => Promise<T>} loader
 * @template T
 */
export async function cachedMoleculeFetch(cacheKey, ttlMs, loader) {
  const now = Date.now();
  const hit = responseCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return /** @type {T} */ (hit.value);
  }
  const value = await loader();
  responseCache.set(cacheKey, { value, expiresAt: now + ttlMs });
  // Bound memory: drop oldest expired / cap size.
  if (responseCache.size > 200) {
    for (const [k, v] of responseCache) {
      if (v.expiresAt <= now) responseCache.delete(k);
    }
    while (responseCache.size > 160) {
      const first = responseCache.keys().next().value;
      if (first == null) break;
      responseCache.delete(first);
    }
  }
  return value;
}

/** Test helper */
export function resetMoleculeResponseCache() {
  responseCache.clear();
}
