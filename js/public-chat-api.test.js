import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST, GET } from "../api/chat.js";
import { ANON_MAX_REQUESTS, resetRateStoreMemory } from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";
import {
  ensureVisitorSession,
  resolveAnonymousVisitorKey,
} from "./chat-visitor.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalAppId = process.env.CURSOR_APP_ID;

/** Official production host (Cursor Apps slug flux-ai-3cdd). */
const PROD_HOST = "flux-ai-3cdd.apps.grok.bot";
const PROD_ORIGIN = `https://${PROD_HOST}`;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalAppId === undefined) delete process.env.CURSOR_APP_ID;
  else process.env.CURSOR_APP_ID = originalAppId;
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
      "x-forwarded-for": "203.0.113.50",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("public POST allows anonymous same-origin chat without Cursor identity", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.CURSOR_APP_ID = "app_public_test";
  process.env.CHAT_SESSION_SECRET = "unit-public-chat-secret";
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
  const setCookie = res.headers.get("set-cookie") || "";
  assert.match(setCookie, /flux_vid=/);
});

test("public POST rejects cross-site Origin", async () => {
  process.env.CURSOR_APP_ID = "app_public_test";
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
  process.env.CURSOR_APP_ID = "app_public_test";
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
  process.env.CURSOR_APP_ID = "app_public_test";
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

test("ten anonymous POSTs same IP+UA without cookie share one visitor rate bucket", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.CURSOR_APP_ID = "app_public_test";
  process.env.CHAT_SESSION_SECRET = "unit-public-chat-secret";
  mockGlucoseLookupFetch();

  const postHeaders = {
    "x-forwarded-for": "203.0.113.10",
    "user-agent": "FluxAnonymousBucketTest/1.0",
  };
  const env = {
    CHAT_SESSION_SECRET: process.env.CHAT_SESSION_SECRET,
    CURSOR_APP_ID: process.env.CURSOR_APP_ID,
  };
  const reqShape = { headers: postHeaders };

  const visitorKeys = new Set();
  const mintedVisitorIds = new Set();
  for (let i = 0; i < 10; i += 1) {
    const session = ensureVisitorSession(reqShape, { env, secureCookie: false });
    assert.equal(session.minted, true);
    mintedVisitorIds.add(session.visitorId);
    visitorKeys.add(resolveAnonymousVisitorKey(reqShape, undefined, { env }));

    const res = await POST(
      chatRequest(
        { messages: [{ role: "user", content: "glucose" }] },
        postHeaders,
      ),
    );
    assert.equal(res.status, 200, `POST ${i + 1}`);
  }
  assert.equal(visitorKeys.size, 1, "all fresh sessions must map to one rate bucket");
  assert.equal(mintedVisitorIds.size, 1, "deterministic flux_vid per IP+UA without cookie");

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
  process.env.CURSOR_APP_ID = "app_public_test";
  process.env.CHAT_SESSION_SECRET = "unit-public-chat-secret";
  mockGlucoseLookupFetch();

  const headers = {
    host: PROD_HOST,
    origin: PROD_ORIGIN,
    "x-forwarded-for": "203.0.113.77",
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
      { "x-forwarded-for": "203.0.113.77" },
    ),
  );
  assert.equal(post.status, 200);
  const data = await post.json();
  assert.equal(data.ok, true);
});

test("missing Groq key still returns a safe molecule fallback reply", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.CURSOR_APP_ID = "app_public_test";
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
