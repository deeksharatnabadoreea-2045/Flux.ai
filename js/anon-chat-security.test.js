/**
 * Anonymous chat production hardening — scenarios A–I.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST, GET } from "../api/chat.js";
import {
  GLOBAL_ANON_DAILY_MAX,
  enforceChatRateLimits,
  resetRateStoreMemory,
  resolveGlobalAnonDailyMax,
} from "./chat-rate-store.mjs";
import { preflightAnonymousChatPost } from "./chat-security.mjs";
import { resetLocalDatabase } from "./db.mjs";
import {
  resolveAnonRateSecret,
  resolveAnonymousVisitorKey,
  stableAnonymousVisitorId,
  trustedClientKey,
} from "./chat-visitor.mjs";

const PROD_HOST = "flux-ai-3cdd.apps.grok.bot";
const PROD_ORIGIN = `https://${PROD_HOST}`;

const saved = {};

afterEach(async () => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = saved.__fetch;
  resetRateStoreMemory();
  await resetLocalDatabase();
});

function stashEnv(keys) {
  for (const key of keys) {
    saved[key] = process.env[key];
  }
}

function publishedTestEnv(overrides = {}) {
  stashEnv(["CURSOR_APP_ID", "CHAT_SESSION_SECRET", "DATABASE_URL", "GROQ_API_KEY"]);
  process.env.CURSOR_APP_ID = "app_hardening_test";
  process.env.CHAT_SESSION_SECRET = "hardening-unit-secret";
  process.env.DATABASE_URL = "pglite://unit-hardening";
  delete process.env.GROQ_API_KEY;
  Object.assign(process.env, overrides);
}

function chatPost(body, headers = {}) {
  return new Request(`${PROD_ORIGIN}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: PROD_HOST,
      origin: PROD_ORIGIN,
      "x-vercel-forwarded-for": "203.0.113.50",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function mockGlucoseFetch() {
  saved.__fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/property/MolecularFormula")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          PropertyTable: {
            Properties: [{ CID: 5793, MolecularFormula: "C6H12O6", MolecularWeight: "180.16" }],
          },
        }),
      };
    }
    if (href.includes("/synonyms/JSON")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InformationList: { Information: [{ CID: 5793, Synonym: ["CHEBI:17234"] }] },
        }),
      };
    }
  if (href.includes("heading=HMDB%20ID") || href.includes("/chebi/")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

test("A — visitor bucket is HMAC(trusted IP) only; UA changes do not reset", () => {
  publishedTestEnv();
  const env = { CURSOR_APP_ID: process.env.CURSOR_APP_ID, CHAT_SESSION_SECRET: process.env.CHAT_SESSION_SECRET };
  const baseHeaders = { "x-vercel-forwarded-for": "203.0.113.42" };
  const a = resolveAnonymousVisitorKey({ headers: { ...baseHeaders, "user-agent": "Agent/A" } }, undefined, { env });
  const b = resolveAnonymousVisitorKey({ headers: { ...baseHeaders, "user-agent": "Agent/B" } }, undefined, { env });
  assert.equal(a, b);
  assert.notEqual(
    a,
    resolveAnonymousVisitorKey(
      { headers: { "x-vercel-forwarded-for": "203.0.113.43", "user-agent": "Agent/A" } },
      undefined,
      { env },
    ),
  );
});

test("B — published app without rate HMAC secret fails closed (503)", async () => {
  publishedTestEnv({ CHAT_SESSION_SECRET: "", CHAT_ANON_RATE_SALT: "" });
  const pre = preflightAnonymousChatPost(chatPost({ message: "hi" }));
  assert.equal(pre.ok, false);
  assert.equal(pre.status, 503);
  assert.equal(pre.error, "chat_rate_secret_missing");
  const res = await POST(chatPost({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, "chat_rate_secret_missing");
});

test("C — published app without trusted client IP fails closed (503)", async () => {
  publishedTestEnv();
  const req = new Request(`${PROD_ORIGIN}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: PROD_HOST,
      origin: PROD_ORIGIN,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const pre = preflightAnonymousChatPost(req);
  assert.equal(pre.ok, false);
  assert.equal(pre.error, "client_ip_unavailable");
});

test("D — published app without DATABASE_URL fails closed (503)", async () => {
  publishedTestEnv();
  delete process.env.DATABASE_URL;
  const res = await POST(chatPost({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "rate_store_unavailable");
});

test("E — durable rate store errors fail closed without upstream", async () => {
  publishedTestEnv();
  await resetLocalDatabase();
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/none";
  const res = await POST(chatPost({ messages: [{ role: "user", content: "glucose" }] }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "rate_store_unavailable");
});

test("F — global anon daily key is fleet-wide and env cannot exceed ceiling", async () => {
  publishedTestEnv({ CHAT_GLOBAL_ANON_DAILY_MAX: "99999" });
  assert.equal(resolveGlobalAnonDailyMax(), GLOBAL_ANON_DAILY_MAX);
  resetRateStoreMemory();
  await resetLocalDatabase();
  process.env.CHAT_GLOBAL_ANON_DAILY_MAX = "2";
  for (let i = 0; i < 2; i += 1) {
    const ok = await enforceChatRateLimits({
      visitorKey: `anon:global-${i}`,
      ipKey: "ip:203.0.113.1",
      signedIn: false,
      env: process.env,
    });
    assert.equal(ok.allowed, true);
  }
  const blocked = await enforceChatRateLimits({
    visitorKey: "anon:global-block",
    ipKey: "ip:203.0.113.9",
    signedIn: false,
    env: process.env,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "global_daily");
});

test("G — GET health never sets flux_vid", async () => {
  publishedTestEnv();
  const res = await GET(
    new Request(`${PROD_ORIGIN}/api/chat`, {
      headers: { host: PROD_HOST, origin: PROD_ORIGIN },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("H — POST does not mint flux_vid cookie", async () => {
  publishedTestEnv();
  mockGlucoseFetch();
  const res = await POST(chatPost({ messages: [{ role: "user", content: "What is glucose?" }] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("I — cross-site Origin rejected before rate limits", async () => {
  publishedTestEnv();
  let fetchCalled = false;
  saved.__fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("should not reach upstream");
  };
  const res = await POST(
    chatPost({ messages: [{ role: "user", content: "hi" }] }, { origin: "https://evil.example" }),
  );
  assert.equal(res.status, 403);
  assert.equal(fetchCalled, false);
});

test("resolveAnonRateSecret accepts CHAT_ANON_RATE_SALT without session secret", () => {
  const r = resolveAnonRateSecret({
    CURSOR_APP_ID: "app_x",
    CHAT_ANON_RATE_SALT: "salt-only",
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, "CHAT_ANON_RATE_SALT");
});

test("trustedClientKey prefers x-vercel-forwarded-for on Cursor Apps", () => {
  const key = trustedClientKey(
    { headers: { "x-vercel-forwarded-for": "198.51.100.7, 10.0.0.1" } },
    { env: { CURSOR_APP_ID: "app_x" } },
  );
  assert.equal(key, "ip:198.51.100.7");
});

test("stableAnonymousVisitorId ignores UA in digest input", () => {
  const env = { CHAT_SESSION_SECRET: "s", CURSOR_APP_ID: "app" };
  const h = { "x-vercel-forwarded-for": "203.0.113.5" };
  assert.equal(
    stableAnonymousVisitorId({ headers: { ...h, "user-agent": "A" } }, { env }),
    stableAnonymousVisitorId({ headers: { ...h, "user-agent": "B" } }, { env }),
  );
});