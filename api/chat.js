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
import {
  ensureVisitorSession,
  trustedClientKey,
} from "../js/chat-visitor.mjs";
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

/**
 * @param {Response} response
 * @param {string | null} setCookie
 */
function withVisitorCookie(response, setCookie) {
  if (!setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(request) {
  const originGate = assertChatBrowserOrigin(request.headers);
  // Health may be polled same-origin; still reject obvious cross-site probes.
  if (!originGate.ok && originGate.error === "origin_forbidden") {
    return json(403, { ok: false, error: originGate.error });
  }

  const identity = await getIdentity(request);
  const session = ensureVisitorSession(request);
  const health = {
    ...chatHealth(),
    publicChat: true,
    signedIn: Boolean(identity.verified),
    deployRevision: DEPLOY_REVISION,
    deployRevisionShort: DEPLOY_REVISION_SHORT,
    basedOnMain: DEPLOY_BASED_ON_MAIN,
    basedOnMainShort: DEPLOY_BASED_ON_MAIN_SHORT,
    deployStamp: DEPLOY_STAMP,
  };
  return withVisitorCookie(json(200, health), session.setCookie);
}

export async function POST(request) {
  const originGate = assertChatBrowserOrigin(request.headers);
  if (!originGate.ok) {
    return json(403, { ok: false, error: originGate.error });
  }

  const identity = await getIdentity(request);
  const signedIn = Boolean(identity.verified);
  const session = ensureVisitorSession(request);
  const visitorKey = signedIn
    ? `user:${identity.sub || identity.userId || "viewer"}`
    : `anon:${session.visitorId}`;
  const ipKey = trustedClientKey(request);

  const rate = await enforceChatRateLimits({
    visitorKey,
    ipKey,
    signedIn,
  });
  if (!rate.allowed) {
    return withVisitorCookie(
      json(
        429,
        {
          ok: false,
          error: "rate_limited",
          retryAfterSec: rate.retryAfterSec,
          scope: rate.scope,
        },
        { "retry-after": String(rate.retryAfterSec) },
      ),
      session.setCookie,
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_CHAT_BODY_BYTES) {
    return withVisitorCookie(json(413, { ok: false, error: "body_too_large" }), session.setCookie);
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return withVisitorCookie(json(400, { ok: false, error: "invalid_json" }), session.setCookie);
  }

  const validated = validateChatPayload(payload ?? {});
  if (!validated.ok) {
    return withVisitorCookie(json(400, { ok: false, error: validated.error }), session.setCookie);
  }

  try {
    const result = await handleScienceChat(validated.value);
    const { status, ...body } = result;
    // Never echo secrets; strip any accidental key-shaped fields.
    delete body.apiKey;
    delete body.GROQ_API_KEY;
    return withVisitorCookie(
      json(status ?? (body.ok ? 200 : 500), body),
      session.setCookie,
    );
  } catch {
    return withVisitorCookie(json(500, { ok: false, error: "chat_failed" }), session.setCookie);
  }
}
