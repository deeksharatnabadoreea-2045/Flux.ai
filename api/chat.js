/**
 * Cursor Apps chat route: GET/POST /api/chat
 *
 * Public chat: anonymous visitors may POST with same-origin + rate limits.
 * Signed-in Cursor viewers are optional and get higher limits keyed by identity.
 * GROQ_API_KEY stays in process.env (server only) — never sent to the browser.
 */

import { getIdentity } from "../cursor/identity.js";
import {
  assertChatBrowserOrigin,
  MAX_CHAT_BODY_BYTES,
  validateChatPayload,
} from "../js/chat-guard.mjs";
import { enforceChatRateLimits } from "../js/chat-rate-store.mjs";
import { preflightAnonymousChatPost } from "../js/chat-security.mjs";
import { resolveAnonymousVisitorKey, trustedClientKey } from "../js/chat-visitor.mjs";
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

export async function GET(request) {
  const originGate = assertChatBrowserOrigin(request.headers);
  // Health may be polled same-origin or by ops without Origin; still reject
  // obvious cross-site probes. Never consume the POST rate-limit budget.
  if (!originGate.ok && originGate.error === "origin_forbidden") {
    return json(403, { ok: false, error: originGate.error });
  }

  const identity = await getIdentity(request);
  const health = {
    ...chatHealth(),
    publicChat: true,
    route: "/api/chat",
    signedIn: Boolean(identity.verified),
    deployStamp: DEPLOY_STAMP,
  };
  if (identity.verified) {
    Object.assign(health, {
      deployRevision: DEPLOY_REVISION,
      deployRevisionShort: DEPLOY_REVISION_SHORT,
      basedOnMain: DEPLOY_BASED_ON_MAIN,
      basedOnMainShort: DEPLOY_BASED_ON_MAIN_SHORT,
    });
  }
  return json(200, health);
}

export async function POST(request) {
  const originGate = assertChatBrowserOrigin(request.headers);
  if (!originGate.ok) {
    return json(403, { ok: false, error: originGate.error });
  }

  const identity = await getIdentity(request);
  const signedIn = Boolean(identity.verified);

  const preflight = preflightAnonymousChatPost(request, { signedIn });
  if (!preflight.ok) {
    return json(503, { ok: false, error: preflight.error });
  }

  const ipKey = trustedClientKey(request);
  const visitorKey = signedIn
    ? `user:${identity.sub || identity.userId || "viewer"}`
    : resolveAnonymousVisitorKey(request);

  const rate = await enforceChatRateLimits({
    visitorKey,
    ipKey,
    signedIn,
  });
  if (!rate.allowed) {
    if (rate.failClosed) {
      return json(503, { ok: false, error: rate.error ?? "rate_store_unavailable" });
    }
    return json(
      429,
      {
        ok: false,
        error: "rate_limited",
        retryAfterSec: rate.retryAfterSec,
        scope: rate.scope,
      },
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
    // Never echo secrets; strip any accidental key-shaped fields.
    delete body.apiKey;
    delete body.GROQ_API_KEY;
    return json(status ?? (body.ok ? 200 : 500), body);
  } catch {
    return json(500, { ok: false, error: "chat_failed" });
  }
}