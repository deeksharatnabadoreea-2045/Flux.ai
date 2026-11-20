/**
 * Cursor Apps chat route: GET/POST /api/chat
 * Requires a verified Cursor app viewer (private/team sign-in).
 * GROQ_API_KEY stays in process.env (server only). Rate-limited per viewer.
 *
 * Legacy Netlify function (`netlify/functions/chat.mjs`) remains for tests only — production is Cursor Apps.
 */

import { requireIdentity } from "../cursor/identity.js";
import {
  checkChatRateLimit,
  MAX_CHAT_BODY_BYTES,
  validateChatPayload,
} from "../js/chat-guard.mjs";
import {
  DEPLOY_BASED_ON_MAIN,
  DEPLOY_BASED_ON_MAIN_SHORT,
  DEPLOY_REVISION,
  DEPLOY_REVISION_SHORT,
  DEPLOY_STAMP,
} from "../js/deploy-revision.js";
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
  // Health is authenticated but does not consume the POST abuse budget.
  return json(200, {
    ...chatHealth(),
    deployRevision: DEPLOY_REVISION,
    deployRevisionShort: DEPLOY_REVISION_SHORT,
    basedOnMain: DEPLOY_BASED_ON_MAIN,
    basedOnMainShort: DEPLOY_BASED_ON_MAIN_SHORT,
    deployStamp: DEPLOY_STAMP,
  });
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

  const rawBody = await request.text();
  if (rawBody.length > MAX_CHAT_BODY_BYTES) {
    return json(413, { ok: false, error: "body_too_large" });
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
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
