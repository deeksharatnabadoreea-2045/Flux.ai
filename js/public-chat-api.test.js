import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST, GET } from "../api/chat.js";
import { resetRateStoreMemory } from "./chat-rate-store.mjs";
import { resetLocalDatabase } from "./db.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalAppId = process.env.CURSOR_APP_ID;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalAppId === undefined) delete process.env.CURSOR_APP_ID;
  else process.env.CURSOR_APP_ID = originalAppId;
  resetRateStoreMemory();
  await resetLocalDatabase();
});

function chatRequest(body, headers = {}) {
  return new Request("https://flux-ai.apps.grok.bot/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "flux-ai.apps.grok.bot",
      origin: "https://flux-ai.apps.grok.bot",
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
    new Request("https://flux-ai.apps.grok.bot/api/chat", {
      headers: {
        host: "flux-ai.apps.grok.bot",
        origin: "https://flux-ai.apps.grok.bot",
      },
    }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.publicChat, true);
  assert.equal(data.groqConfigured, false);
  assert.doesNotMatch(JSON.stringify(data), /gsk_|CHAT_SESSION_SECRET/);
});

test("missing Groq key still returns a safe molecule fallback reply", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.CURSOR_APP_ID = "app_public_test";
  const res = await POST(
    chatRequest({ messages: [{ role: "user", content: "water" }] }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.groqConfigured, false);
  assert.ok(data.reply);
});
