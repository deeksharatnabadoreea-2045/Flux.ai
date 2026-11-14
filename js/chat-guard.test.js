import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkChatRateLimit,
  resetChatRateLimits,
  safeChatProviderError,
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
