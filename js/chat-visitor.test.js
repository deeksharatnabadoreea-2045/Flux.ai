import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureVisitorSession,
  mintVisitorToken,
  resolveSessionSecret,
  trustedClientKey,
  verifyVisitorToken,
  VISITOR_COOKIE,
} from "./chat-visitor.mjs";

test("resolveSessionSecret prefers CHAT_SESSION_SECRET", () => {
  const r = resolveSessionSecret({ CHAT_SESSION_SECRET: "super-secret-value" });
  assert.equal(r.source, "CHAT_SESSION_SECRET");
  assert.equal(r.secret, "super-secret-value");
});

test("mint + verify visitor token round-trip", () => {
  const secret = "unit-test-secret";
  const { visitorId, token } = mintVisitorToken("11111111-1111-4111-8111-111111111111", secret);
  const ok = verifyVisitorToken(token, secret);
  assert.equal(ok.ok, true);
  assert.equal(ok.visitorId, visitorId);
  assert.equal(verifyVisitorToken(token + "x", secret).ok, false);
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
