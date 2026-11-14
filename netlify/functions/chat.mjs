/**
 * Netlify Function: conversational science chat via Groq.
 * Uses GROQ_API_KEY from Netlify environment variables (server-side only).
 *
 * Public to same-origin Flux visitors (browser Origin/Referer must match Host).
 * Rate-limited per client IP; payloads validated before any provider call.
 */

import {
  assertChatBrowserOrigin,
  checkChatRateLimit,
  clientKeyFromHeaders,
  MAX_CHAT_BODY_BYTES,
  validateChatPayload,
} from "../../js/chat-guard.mjs";
import { chatHealth, handleScienceChat } from "../../js/science-chat.mjs";

function json(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function headerMap(event) {
  const raw = event?.headers || {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

export async function handler(event) {
  const method = event.httpMethod || "GET";
  const headers = headerMap(event);

  // No CORS wide-open: same-origin browser calls only. Preflight is unused for same-origin.
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "cache-control": "private, no-store",
      },
      body: "",
    };
  }

  if (method !== "GET" && method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const originGate = assertChatBrowserOrigin(headers);
  if (!originGate.ok) {
    return json(403, { ok: false, error: originGate.error });
  }

  const clientKey = clientKeyFromHeaders(headers);
  const rate = checkChatRateLimit(`netlify:${clientKey}`);
  if (!rate.allowed) {
    return json(
      429,
      { ok: false, error: "rate_limited", retryAfterSec: rate.retryAfterSec },
      { "retry-after": String(rate.retryAfterSec) },
    );
  }

  if (method === "GET") {
    return json(200, chatHealth());
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : String(event.body || "");

  if (rawBody.length > MAX_CHAT_BODY_BYTES) {
    return json(413, { ok: false, error: "body_too_large" });
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const validated = validateChatPayload(payload);
  if (!validated.ok) {
    return json(400, { ok: false, error: validated.error });
  }

  try {
    const result = await handleScienceChat(validated.value);
    const { status, ...body } = result;
    return json(status ?? (body.ok ? 200 : 500), body);
  } catch {
    return json(500, { ok: false, error: "chat_failed" });
  }
}
