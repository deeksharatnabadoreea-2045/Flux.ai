/**
 * Cursor Apps chat route: GET/POST /api/chat
 * Requires a verified Cursor app viewer (private/team sign-in).
 * GROQ_API_KEY stays in process.env (server only). Rate-limited per viewer.
 *
 * Netlify keeps a separate same-origin + rate-limited function for cutover.
 */

import { requireIdentity } from "../cursor/identity.js";
import { checkChatRateLimit, validateChatPayload } from "../js/chat-guard.mjs";
import { chatHealth, handleScienceChat } from "../js/science-chat.mjs";

function json(status, body, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", ...extraHeaders },
  });
}

async function requireViewer(request) {
  const identity = await requireIdentity(request);
  if (identity instanceof Response) return identity;
  return identity;
}

export async function GET(request) {
  const identity = await requireViewer(request);
  if (identity instanceof Response) return identity;
  return json(200, chatHealth());
}

export async function POST(request) {
  const identity = await requireViewer(request);
  if (identity instanceof Response) return identity;

  const rate = checkChatRateLimit(identity.sub || identity.userId || "viewer");
  if (!rate.allowed) {
    return json(
      429,
      { ok: false, error: "rate_limited", retryAfterSec: rate.retryAfterSec },
      { "retry-after": String(rate.retryAfterSec) },
    );
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const validated = validateChatPayload(payload ?? {});
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
