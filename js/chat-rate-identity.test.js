import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveAnonRateSecret,
  resolveAnonymousVisitorKey,
  stableAnonymousVisitorId,
  trustedClientKey,
} from "./chat-rate-identity.mjs";

test("resolveAnonRateSecret prefers CHAT_ANON_RATE_SALT", () => {
  const r = resolveAnonRateSecret({
    CHAT_ANON_RATE_SALT: "salt-only",
    CURSOR_APP_ID: "app_x",
  });
  assert.equal(r.source, "CHAT_ANON_RATE_SALT");
  assert.equal(r.secret, "salt-only");
  assert.equal(r.ok, true);
});

test("resolveAnonRateSecret chains CHAT_SESSION_SECRET when salt unset", () => {
  const r = resolveAnonRateSecret({ CHAT_SESSION_SECRET: "super-secret-value" });
  assert.equal(r.source, "CHAT_SESSION_SECRET");
  assert.equal(r.secret, "super-secret-value");
  assert.equal(r.ok, true);
});

test("resolveAnonRateSecret requires secret on published app", () => {
  const r = resolveAnonRateSecret({ CURSOR_APP_ID: "app_prod_xyz" });
  assert.equal(r.ok, false);
  assert.equal(r.source, "missing");
  assert.equal(r.secret, null);
});

test("stableAnonymousVisitorId is stable per trusted IP (UA ignored)", () => {
  const env = { CHAT_SESSION_SECRET: "unit-salt", CURSOR_APP_ID: "app_test" };
  const ipHeaders = { "x-forwarded-for": "203.0.113.88" };
  const a = stableAnonymousVisitorId(
    { headers: { ...ipHeaders, "user-agent": "FluxTest/1.0" } },
    { env },
  );
  const b = stableAnonymousVisitorId(
    { headers: { ...ipHeaders, "user-agent": "OtherAgent/2.0" } },
    { env },
  );
  assert.equal(a, b);
  assert.notEqual(
    a,
    stableAnonymousVisitorId(
      { headers: { "x-forwarded-for": "203.0.113.89", "user-agent": "FluxTest/1.0" } },
      { env },
    ),
  );
});

test("trustedClientKey uses Netlify IP and ignores untrusted local XFF", () => {
  assert.equal(
    trustedClientKey({ headers: { "x-nf-client-connection-ip": "203.0.113.9" } }),
    "ip:203.0.113.9",
  );
  assert.equal(
    trustedClientKey({ headers: { "x-forwarded-for": "198.51.100.2" } }, { env: {} }),
    "ip:unknown",
  );
  assert.equal(
    trustedClientKey(
      { headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" } },
      { env: { CURSOR_APP_ID: "app_test" } },
    ),
    "ip:198.51.100.2",
  );
});

test("resolveAnonymousVisitorKey matches same IP regardless of UA", () => {
  const env = { CHAT_SESSION_SECRET: "abc", CURSOR_APP_ID: "app_test" };
  const base = { "x-forwarded-for": "203.0.113.50" };
  const reqA = { headers: { ...base, "user-agent": "Mozilla/5.0" } };
  const reqB = { headers: { ...base, "user-agent": "Other/1" } };
  assert.equal(
    resolveAnonymousVisitorKey(reqA, undefined, { env }),
    resolveAnonymousVisitorKey(reqB, undefined, { env }),
  );
});

test("flux_vid cookie header does not change anonymous rate bucket", () => {
  const env = { CHAT_SESSION_SECRET: "abc", CURSOR_APP_ID: "app_test" };
  const headers = { "x-vercel-forwarded-for": "203.0.113.50" };
  const plain = resolveAnonymousVisitorKey({ headers }, undefined, { env });
  const withCookie = resolveAnonymousVisitorKey(
    { headers: { ...headers, cookie: "flux_vid=fake.visitor.token.sig" } },
    undefined,
    { env },
  );
  assert.equal(plain, withCookie);
});