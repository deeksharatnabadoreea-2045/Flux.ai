import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  ANON_MAX_REQUESTS,
  enforceChatRateLimits,
  resetRateStoreMemory,
} from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";

after(async () => {
  resetRateStoreMemory();
  await resetLocalDatabase();
});

test("enforceChatRateLimits blocks anonymous visitor after window max", async () => {
  resetRateStoreMemory();
  await resetLocalDatabase();
  const visitorKey = `anon:rate-test-${Date.now()}`;
  const ipKey = `ip:203.0.113.${Math.floor(Math.random() * 200)}`;

  for (let i = 0; i < ANON_MAX_REQUESTS; i += 1) {
    const r = await enforceChatRateLimits({
      visitorKey,
      ipKey,
      signedIn: false,
    });
    assert.equal(r.allowed, true, `request ${i + 1}`);
  }
  const blocked = await enforceChatRateLimits({
    visitorKey,
    ipKey,
    signedIn: false,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test("signed-in visitors use a separate higher bucket", async () => {
  resetRateStoreMemory();
  await resetLocalDatabase();
  const ok = await enforceChatRateLimits({
    visitorKey: `user:signed-${Date.now()}`,
    ipKey: `ip:198.51.100.${Math.floor(Math.random() * 200)}`,
    signedIn: true,
  });
  assert.equal(ok.allowed, true);
});
