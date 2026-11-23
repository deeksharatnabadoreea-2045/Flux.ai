/**
 * Regression: production POST /api/chat must not depend on flux_vid session code.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { POST, GET } from "../api/chat.js";
import { resetRateStoreMemory, ANON_MAX_REQUESTS } from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_IN_SOURCE = [
  "chat-visitor.mjs",
  "ensureVisitorSession",
  "mintVisitorToken",
  "visitorSetCookieHeader",
  "VISITOR_COOKIE",
  "flux_vid",
];

const PROD_HOST = "flux-ai-3cdd.apps.grok.bot";
const PROD_ORIGIN = `https://${PROD_HOST}`;

async function readRepo(relPath) {
  return readFile(join(ROOT, relPath), "utf8");
}

function chatPost(body, headers = {}) {
  return new Request(`${PROD_ORIGIN}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: PROD_HOST,
      origin: PROD_ORIGIN,
      "x-vercel-forwarded-for": "203.0.113.88",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("1 — api/chat.js does not import chat-visitor or cookie session APIs", async () => {
  const src = await readRepo("api/chat.js");
  for (const needle of FORBIDDEN_IN_SOURCE) {
    assert.doesNotMatch(src, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(src, /chat-rate-identity\.mjs/);
});

test("2 — chat-security.mjs imports only chat-rate-identity", async () => {
  const src = await readRepo("js/chat-security.mjs");
  assert.match(src, /chat-rate-identity\.mjs/);
  assert.doesNotMatch(src, /chat-visitor/);
});

test("3 — company-dev.mjs chat path uses chat-rate-identity not chat-visitor", async () => {
  const src = await readRepo("scripts/company-dev.mjs");
  assert.match(src, /chat-rate-identity\.mjs/);
  assert.doesNotMatch(src, /chat-visitor/);
});

test("4 — chat-rate-identity.mjs has no cookie/session surface", async () => {
  const src = await readRepo("js/chat-rate-identity.mjs");
  for (const needle of [
    "flux_vid",
    "ensureVisitorSession",
    "mintVisitorToken",
    "readCookie",
    "verifyVisitorToken",
    "randomUUID",
    "Set-Cookie",
  ]) {
    assert.doesNotMatch(src, new RegExp(needle));
  }
});

test("5 — GET /api/chat never emits Set-Cookie", async () => {
  process.env.CURSOR_APP_ID = "regression_get";
  process.env.CHAT_SESSION_SECRET = "regression-secret";
  const res = await GET(
    new Request(`${PROD_ORIGIN}/api/chat`, {
      headers: { host: PROD_HOST, origin: PROD_ORIGIN },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("6 — successful POST never emits Set-Cookie", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.CURSOR_APP_ID = "regression_post";
  process.env.CHAT_SESSION_SECRET = "regression-secret";
  process.env.DATABASE_URL = "pglite://flux-vid-removal";
  const prevFetch = globalThis.fetch;
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
  try {
    const res = await POST(
      chatPost({ messages: [{ role: "user", content: "glucose" }] }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    globalThis.fetch = prevFetch;
    await resetLocalDatabase();
    resetRateStoreMemory();
  }
});

test("7 — rate-limited POST does not emit Set-Cookie", async () => {
  process.env.CURSOR_APP_ID = "regression_429";
  process.env.CHAT_SESSION_SECRET = "regression-secret";
  process.env.DATABASE_URL = "pglite://flux-vid-removal-429";
  resetRateStoreMemory();
  await resetLocalDatabase();
  const headers = { "x-vercel-forwarded-for": "203.0.113.199" };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ PropertyTable: { Properties: [] } }),
  });
  for (let i = 0; i < ANON_MAX_REQUESTS; i += 1) {
    await POST(chatPost({ messages: [{ role: "user", content: "x" }] }, headers));
  }
  const blocked = await POST(
    chatPost({ messages: [{ role: "user", content: "x" }] }, headers),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  resetRateStoreMemory();
  await resetLocalDatabase();
});

test("8 — chat-rate-identity is reachable from api/chat without chat-visitor on disk", async () => {
  const { trustedClientKey } = await import("./chat-rate-identity.mjs");
  assert.equal(
    trustedClientKey(
      { headers: { "x-vercel-forwarded-for": "203.0.113.1" } },
      { env: { CURSOR_APP_ID: "x" } },
    ),
    "ip:203.0.113.1",
  );
  let visitorMissing = false;
  try {
    await import("./chat-visitor.mjs");
  } catch {
    visitorMissing = true;
  }
  assert.equal(visitorMissing, true, "legacy chat-visitor.mjs must be removed");
});

test("9 — deploy-revision keeps security base SHA (b8ce66e)", async () => {
  const mod = await import("./deploy-revision.js");
  assert.equal(mod.DEPLOY_BASED_ON_MAIN_SHORT, "b8ce66e");
  assert.equal(mod.STATIC_CACHE_BUST, "chat-origin-mol-limits-1");
  assert.match(mod.DEPLOY_STAMP, /chat-origin-mol-limits/);
});

test("10 — production graph modules: chat-rate-store → chat-security → chat-rate-identity", async () => {
  const store = await readRepo("js/chat-rate-store.mjs");
  const security = await readRepo("js/chat-security.mjs");
  assert.match(store, /chat-security\.mjs/);
  assert.doesNotMatch(store, /chat-visitor/);
  assert.match(security, /chat-rate-identity\.mjs/);
  assert.doesNotMatch(security, /chat-visitor/);
});