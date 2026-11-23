import assert from "node:assert/strict";
import { test } from "node:test";
import { resetChatRateLimits } from "./chat-guard.mjs";
import {
  cachedMoleculeFetch,
  enforceMoleculeRateLimit,
  MOLECULE_MAX_REQUESTS,
  resetMoleculeResponseCache,
} from "./molecules-api.mjs";

test("enforceMoleculeRateLimit allows then blocks after shared IP budget", () => {
  resetChatRateLimits();
  const req = {
    headers: { "x-forwarded-for": "198.51.100.77" },
  };
  for (let i = 0; i < MOLECULE_MAX_REQUESTS; i += 1) {
    assert.equal(enforceMoleculeRateLimit(req).allowed, true);
  }
  const blocked = enforceMoleculeRateLimit(req);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test("cachedMoleculeFetch returns cached value within TTL", async () => {
  resetMoleculeResponseCache();
  let loads = 0;
  const first = await cachedMoleculeFetch("unit-key", 60_000, async () => {
    loads += 1;
    return { ok: true, n: loads };
  });
  const second = await cachedMoleculeFetch("unit-key", 60_000, async () => {
    loads += 1;
    return { ok: true, n: loads };
  });
  assert.deepEqual(first, { ok: true, n: 1 });
  assert.deepEqual(second, { ok: true, n: 1 });
  assert.equal(loads, 1);
});
