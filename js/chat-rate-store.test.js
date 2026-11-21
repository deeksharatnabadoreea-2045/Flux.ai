import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  ANON_MAX_REQUESTS,
  IP_DAILY_MAX,
  consumeRateLimit,
  enforceChatRateLimits,
  resetRateStoreMemory,
} from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";

const prevGlobalCap = process.env.CHAT_GLOBAL_ANON_DAILY_MAX;

after(async () => {
  if (prevGlobalCap === undefined) delete process.env.CHAT_GLOBAL_ANON_DAILY_MAX;
  else process.env.CHAT_GLOBAL_ANON_DAILY_MAX = prevGlobalCap;
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

test("enforceChatRateLimits blocks IP after daily max across visitor keys", async () => {
  resetRateStoreMemory();
  await resetLocalDatabase();
  const ipKey = `ip:203.0.113.${Math.floor(Math.random() * 200)}`;
  const dayKey = new Date().toISOString().slice(0, 10);
  const ipDailyOpts = {
    limit: IP_DAILY_MAX,
    windowMs: 24 * 60 * 60 * 1000,
  };

  for (let i = 0; i < IP_DAILY_MAX; i += 1) {
    const r = await consumeRateLimit(`ipday:${dayKey}:${ipKey}`, ipDailyOpts);
    assert.equal(r.allowed, true, `ipday priming ${i + 1}`);
  }

  const blocked = await enforceChatRateLimits({
    visitorKey: `anon:ip-day-block-${Date.now()}`,
    ipKey,
    signedIn: false,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "ip_daily");
  assert.ok(blocked.retryAfterSec >= 1);
});

test("global anonymous daily cap blocks after threshold", async () => {
  resetRateStoreMemory();
  await resetLocalDatabase();
  process.env.CHAT_GLOBAL_ANON_DAILY_MAX = "3";
  const ipKey = `ip:203.0.113.${Math.floor(Math.random() * 200)}`;

  process.env.DATABASE_URL = "pglite://rate-store-global";
  for (let i = 0; i < 3; i += 1) {
    const r = await enforceChatRateLimits({
      visitorKey: `anon:global-test-${i}-${Date.now()}`,
      ipKey: `ip:198.51.100.${i}`,
      signedIn: false,
      env: process.env,
    });
    assert.equal(r.allowed, true, `request ${i + 1}`);
  }
  const blocked = await enforceChatRateLimits({
    visitorKey: `anon:global-block-${Date.now()}`,
    ipKey,
    signedIn: false,
    env: process.env,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "global_daily");
  delete process.env.CHAT_GLOBAL_ANON_DAILY_MAX;
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
