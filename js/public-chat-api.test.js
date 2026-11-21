import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST, GET } from "../api/chat.js";
import { ANON_MAX_REQUESTS, resetRateStoreMemory } from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";
import { resolveAnonymousVisitorKey } from "./chat-rate-identity.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalAppId = process.env.CURSOR_APP_ID;
const originalSecret = process.env.CHAT_SESSION_SECRET;
const originalDb = process.env.DATABASE_URL;

/** Official production host (Cursor Apps slug flux-ai-3cdd). */
const PROD_HOST = "flux-ai-3cdd.apps.grok.bot";
const PROD_ORIGIN = `https://${PROD_HOST}`;

function enablePublishedChatEnv() {
  process.env.CURSOR_APP_ID = "app_public_test";
  process.env.CHAT_SESSION_SECRET = "unit-public-chat-secret";
  process.env.DATABASE_URL = "pglite://public-chat-api";
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalAppId === undefined) delete process.env.CURSOR_APP_ID;
  else process.env.CURSOR_APP_ID = originalAppId;
  if (originalSecret === undefined) delete process.env.CHAT_SESSION_SECRET;
  else process.env.CHAT_SESSION_SECRET = originalSecret;
  if (originalDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDb;
  resetRateStoreMemory();
  await resetLocalDatabase();
});

/** Deterministic PubChem + human-evidence stubs (no live network). */
function mockGlucoseLookupFetch() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/property/MolecularFormula")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          PropertyTable: {
            Properties: [
              { CID: 5793, MolecularFormula: "C6H12O6", MolecularWeight: "180.16" },
            ],
          },
        }),
      };
    }
    if (href.includes("/synonyms/JSON")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InformationList: {
            Information: [{ CID: 5793, Synonym: ["CHEBI:17234"] }],
          },
        }),
      };
    }
    if (href.includes("heading=HMDB%20ID")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Record: {
            Section: [
              {
                Information: [
                  { Value: { StringWithMarkup: [{ String: "HMDB0000122" }] } },
                ],
              },
            ],
          },
        }),
      };
    }
    if (href.includes("/chebi/backend/api/public/compound/17234/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles_classification: { name: "human metabolite" },
          compound_origins: [],
        }),
      };
    }
    throw new Error(`unexpected fetch in public-chat test: ${href}`);
  };
}

function chatRequest(body, headers = {}) {
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

test("public POST allows anonymous same-origin chat without Cursor identity", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  mockGlucoseLookupFetch();

  const res = await POST(
    chatRequest({
      messages: [{ role: "user", content: "What is glucose?" }],
    }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(String(data.reply || "").length > 10);
  assert.doesNotMatch(JSON.stringify(data), /gsk_|GROQ_API_KEY|sk-[a-zA-Z0-9]/);
  assert.equal(res.headers.get("set-cookie"), null, "POST does not mint flux_vid");
});

test("public POST rejects cross-site Origin", async () => {
  enablePublishedChatEnv();
  const res = await POST(
    chatRequest(
      { messages: [{ role: "user", content: "hi" }] },
      { origin: "https://evil.example" },
    ),
  );
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error, "origin_forbidden");
});

test("public GET health reports publicChat without secrets", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  const res = await GET(
    new Request(`${PROD_ORIGIN}/api/chat`, {
      headers: {
        host: PROD_HOST,
        origin: PROD_ORIGIN,
      },
    }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.publicChat, true);
  assert.equal(data.route, "/api/chat");
  assert.equal(data.groqConfigured, false);
  assert.ok(data.deployStamp);
  assert.equal(data.deployRevision, undefined);
  assert.equal(data.basedOnMain, undefined);
  assert.doesNotMatch(JSON.stringify(data), /gsk_|CHAT_SESSION_SECRET|[0-9a-f]{40}/);
  assert.equal(res.headers.get("set-cookie"), null, "GET health does not mint flux_vid");
});

test("public GET health without Origin skips visitor cookie mint", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  const res = await GET(
    new Request(`${PROD_ORIGIN}/api/chat`, {
      headers: { host: PROD_HOST },
    }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.publicChat, true);
  assert.equal(data.route, "/api/chat");
  assert.equal(res.headers.get("set-cookie"), null);
});

test("ten anonymous POSTs same IP with different UA share one visitor rate bucket", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  mockGlucoseLookupFetch();

  const ip = "203.0.113.10";
  const env = {
    CHAT_SESSION_SECRET: process.env.CHAT_SESSION_SECRET,
    CURSOR_APP_ID: process.env.CURSOR_APP_ID,
  };

  const visitorKeys = new Set();
  for (let i = 0; i < 10; i += 1) {
    const postHeaders = {
      "x-vercel-forwarded-for": ip,
      "user-agent": `SyntheticVisitor/${i}`,
    };
    visitorKeys.add(
      resolveAnonymousVisitorKey({ headers: postHeaders }, undefined, { env }),
    );

    const res = await POST(
      chatRequest(
        { messages: [{ role: "user", content: "glucose" }] },
        postHeaders,
      ),
    );
    assert.equal(res.status, 200, `POST ${i + 1}`);
  }
  assert.equal(visitorKeys.size, 1, "IP-only bucket — UA rotation cannot reset limits");

  const postHeaders = { "x-vercel-forwarded-for": ip, "user-agent": "FluxCapTest/1.0" };
  for (let i = 10; i < ANON_MAX_REQUESTS; i += 1) {
    const res = await POST(
      chatRequest(
        { messages: [{ role: "user", content: "glucose" }] },
        postHeaders,
      ),
    );
    assert.equal(res.status, 200, `POST ${i + 1}`);
  }
  const blocked = await POST(
    chatRequest(
      { messages: [{ role: "user", content: "glucose" }] },
      postHeaders,
    ),
  );
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error, "rate_limited");
  assert.equal(body.scope, "visitor");
});

test("public GET health does not burn POST rate budget", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  mockGlucoseLookupFetch();

  const headers = {
    host: PROD_HOST,
    origin: PROD_ORIGIN,
    "x-vercel-forwarded-for": "203.0.113.77",
  };
  for (let i = 0; i < 40; i += 1) {
    const health = await GET(
      new Request(`${PROD_ORIGIN}/api/chat`, { headers }),
    );
    assert.equal(health.status, 200, `health ${i + 1}`);
  }
  const post = await POST(
    chatRequest(
      { messages: [{ role: "user", content: "glucose" }] },
      { "x-vercel-forwarded-for": "203.0.113.77" },
    ),
  );
  assert.equal(post.status, 200);
  const data = await post.json();
  assert.equal(data.ok, true);
});

test("missing Groq key still returns a safe molecule fallback reply", async () => {
  delete process.env.GROQ_API_KEY;
  enablePublishedChatEnv();
  mockGlucoseLookupFetch();
  const res = await POST(
    chatRequest({ messages: [{ role: "user", content: "glucose" }] }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.groqConfigured, false);
  assert.ok(data.reply);
  assert.match(String(data.reply), /C6H12O6|glucose/i);
});