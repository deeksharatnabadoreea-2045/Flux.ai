import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureVisitorSession,
  mintVisitorToken,
  resolveAnonymousVisitorKey,
  resolveSessionSecret,
  stableAnonymousVisitorId,
  stableIdToVisitorUuid,
  trustedClientKey,
  verifyVisitorToken,
  VISITOR_COOKIE,
} from "./chat-visitor.mjs";

test("resolveSessionSecret prefers CHAT_SESSION_SECRET", () => {
  const r = resolveSessionSecret({ CHAT_SESSION_SECRET: "super-secret-value" });
  assert.equal(r.source, "CHAT_SESSION_SECRET");
  assert.equal(r.secret, "super-secret-value");
  assert.equal(r.ok, true);
});

test("resolveSessionSecret requires CHAT_SESSION_SECRET on published app", () => {
  const r = resolveSessionSecret({ CURSOR_APP_ID: "app_prod_xyz" });
  assert.equal(r.ok, false);
  assert.equal(r.source, "missing");
  assert.equal(r.secret, null);
});

test("stableAnonymousVisitorId is stable per IP+UA without cookie", () => {
  const env = { CHAT_SESSION_SECRET: "unit-salt", CURSOR_APP_ID: "app_test" };
  const headers = {
    "x-forwarded-for": "203.0.113.88",
    "user-agent": "FluxTest/1.0",
  };
  const a = stableAnonymousVisitorId({ headers }, { env });
  const b = stableAnonymousVisitorId({ headers }, { env });
  assert.equal(a, b);
  assert.notEqual(
    a,
    stableAnonymousVisitorId(
      { headers: { "x-forwarded-for": "203.0.113.89", "user-agent": "FluxTest/1.0" } },
      { env },
    ),
  );
});

test("mint + verify visitor token round-trip", () => {
  const secret = "unit-test-secret";
  const { visitorId, token } = mintVisitorToken("11111111-1111-4111-8111-111111111111", secret);
  const ok = verifyVisitorToken(token, secret);
  assert.equal(ok.ok, true);
  assert.equal(ok.visitorId, visitorId);
  assert.equal(verifyVisitorToken(token + "x", secret).ok, false);
});

test("mintVisitorToken rejects empty visitorId", () => {
  assert.throws(
    () => mintVisitorToken("", "secret"),
    /requires a non-empty visitorId/,
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

test("ensureVisitorSession mints cookie then reuses it", () => {
  const first = ensureVisitorSession(
    { headers: {} },
    { env: { CHAT_SESSION_SECRET: "abc" }, secureCookie: false },
  );
  assert.equal(first.minted, true);
  assert.match(first.setCookie, new RegExp(`^${VISITOR_COOKIE}=`));
  const rawPair = first.setCookie.split(";")[0];
  const token = decodeURIComponent(rawPair.slice(rawPair.indexOf("=") + 1));
  const second = ensureVisitorSession(
    { headers: { cookie: `${VISITOR_COOKIE}=${encodeURIComponent(token)}` } },
    { env: { CHAT_SESSION_SECRET: "abc" }, secureCookie: false },
  );
  assert.equal(second.minted, false);
  assert.equal(second.visitorId, first.visitorId);
  assert.equal(second.setCookie, null);
});

test("ensureVisitorSession without CHAT_SESSION_SECRET on app does not mint cookie", () => {
  const session = ensureVisitorSession(
    { headers: { "x-forwarded-for": "203.0.113.1" } },
    { env: { CURSOR_APP_ID: "app_no_secret" } },
  );
  assert.equal(session.minted, true);
  assert.equal(session.setCookie, null);
});

test("resolveAnonymousVisitorKey matches across minted sessions on same IP+UA", () => {
  const env = { CHAT_SESSION_SECRET: "abc", CURSOR_APP_ID: "app_test" };
  const req = {
    headers: {
      "x-forwarded-for": "203.0.113.50",
      "user-agent": "Mozilla/5.0",
    },
  };
  const s1 = ensureVisitorSession(req, { env, secureCookie: false });
  const s2 = ensureVisitorSession(req, { env, secureCookie: false });
  assert.equal(s1.minted, true);
  assert.equal(s2.minted, true);
  assert.equal(s1.visitorId, s2.visitorId, "deterministic flux_vid per IP+UA");
  assert.equal(resolveAnonymousVisitorKey(req, s1, { env }), resolveAnonymousVisitorKey(req, s2, { env }));
});

test("deterministic visitorId from stable hash is a valid UUID", () => {
  const env = { CHAT_SESSION_SECRET: "abc", CURSOR_APP_ID: "app_test" };
  const req = {
    headers: { "x-forwarded-for": "203.0.113.50", "user-agent": "Mozilla/5.0" },
  };
  const stable = stableAnonymousVisitorId(req, { env });
  const uuid = stableIdToVisitorUuid(stable);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const session = ensureVisitorSession(req, { env, secureCookie: false });
  assert.equal(session.visitorId, uuid.toLowerCase());
});
