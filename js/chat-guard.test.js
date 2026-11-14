import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertChatBrowserOrigin,
  checkChatRateLimit,
  clientKeyFromHeaders,
  parseAllowedChatOrigins,
  resetChatRateLimits,
  safeChatProviderError,
  validateChatPayload,
} from "./chat-guard.mjs";

test("checkChatRateLimit allows then blocks after limit", () => {
  resetChatRateLimits();
  const key = "viewer-test";
  for (let i = 0; i < 30; i += 1) {
    assert.equal(checkChatRateLimit(key, { limit: 30 }).allowed, true);
  }
  const blocked = checkChatRateLimit(key, { limit: 30 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test("safeChatProviderError hides Groq/API details", () => {
  assert.match(
    safeChatProviderError(new Error("Groq request failed: HTTP 401 invalid api key")),
    /unavailable|Try again/i,
  );
  assert.doesNotMatch(
    safeChatProviderError(new Error("Groq request failed: secret-token-xyz")),
    /secret-token-xyz/,
  );
});

test("clientKeyFromHeaders prefers Netlify then forwarded IP", () => {
  assert.equal(
    clientKeyFromHeaders({ "x-nf-client-connection-ip": "203.0.113.9" }),
    "ip:203.0.113.9",
  );
  assert.equal(
    clientKeyFromHeaders({ "x-forwarded-for": "198.51.100.2, 10.0.0.1" }),
    "ip:198.51.100.2",
  );
  assert.equal(clientKeyFromHeaders({}), "ip:unknown");
});

test("assertChatBrowserOrigin allows same-host Origin", () => {
  const ok = assertChatBrowserOrigin({
    host: "flux-ai-bio.netlify.app",
    origin: "https://flux-ai-bio.netlify.app",
  });
  assert.equal(ok.ok, true);
});

test("assertChatBrowserOrigin rejects cross-site and missing Origin", () => {
  assert.equal(
    assertChatBrowserOrigin({
      host: "flux-ai-bio.netlify.app",
      origin: "https://evil.example",
    }).error,
    "origin_forbidden",
  );
  assert.equal(
    assertChatBrowserOrigin({ host: "flux-ai-bio.netlify.app" }).error,
    "origin_required",
  );
});

test("assertChatBrowserOrigin honors CHAT_ALLOWED_ORIGINS", () => {
  const ok = assertChatBrowserOrigin(
    { host: "other.example", origin: "https://flux-ai.apps.grok.bot" },
    { env: { CHAT_ALLOWED_ORIGINS: "https://flux-ai.apps.grok.bot" } },
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(parseAllowedChatOrigins({ CHAT_ALLOWED_ORIGINS: "a, b" }), ["a", "b"]);
});

test("validateChatPayload accepts normal chat and rejects abuse shapes", () => {
  const good = validateChatPayload({
    conversationId: "c1",
    messages: [{ role: "user", content: "What is glucose?" }],
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.messages?.[0]?.content, "What is glucose?");

  assert.equal(validateChatPayload(null).error, "invalid_payload");
  assert.equal(validateChatPayload({ messages: [] }).error, "message_required");
  assert.equal(
    validateChatPayload({
      messages: [{ role: "user", content: "x".repeat(4_001) }],
    }).error,
    "message_too_long",
  );
  assert.equal(
    validateChatPayload({
      messages: Array.from({ length: 25 }, () => ({ role: "user", content: "hi" })),
    }).error,
    "too_many_messages",
  );
});
