import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetChatRateLimits } from "./chat-guard.mjs";
import { handler } from "../netlify/functions/chat.mjs";

const originalKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  resetChatRateLimits();
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

function event(overrides = {}) {
  return {
    httpMethod: "POST",
    headers: {
      host: "flux-ai-bio.netlify.app",
      origin: "https://flux-ai-bio.netlify.app",
      "x-nf-client-connection-ip": "203.0.113.10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "glucose" }],
    }),
    ...overrides,
  };
}

test("Netlify chat is disabled when CURSOR_APP_ID is set", async () => {
  const prev = process.env.CURSOR_APP_ID;
  process.env.CURSOR_APP_ID = "test-app";
  try {
    const res = await handler(event());
    assert.equal(res.statusCode, 410);
    assert.match(res.body, /legacy_netlify_disabled/);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_APP_ID;
    else process.env.CURSOR_APP_ID = prev;
  }
});

test("Netlify chat rejects requests without browser Origin", async () => {
  delete process.env.GROQ_API_KEY;
  const res = await handler(
    event({
      headers: {
        host: "flux-ai-bio.netlify.app",
        "x-nf-client-connection-ip": "203.0.113.10",
      },
    }),
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /origin_required/);
});

test("Netlify chat rejects cross-site Origin", async () => {
  delete process.env.GROQ_API_KEY;
  const res = await handler(
    event({
      headers: {
        host: "flux-ai-bio.netlify.app",
        origin: "https://attacker.example",
        "x-nf-client-connection-ip": "203.0.113.11",
      },
    }),
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /origin_forbidden/);
});

test("Netlify chat serves same-origin visitors (PubChem fallback)", async () => {
  delete process.env.GROQ_API_KEY;
  // Stub PubChem / ChEBI / HMDB so CI is not flaky on NCBI latency.
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
    throw new Error(`unexpected fetch in netlify chat test: ${href}`);
  };
  const res = await handler(event());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.reply);
  assert.equal(body.molecule?.formula, "C6H12O6");
  assert.doesNotMatch(res.body, /gsk_|GROQ_API_KEY/i);
});

test("Netlify chat rate-limits abusive same-origin clients", async () => {
  delete process.env.GROQ_API_KEY;
  // Avoid 30 live PubChem round-trips while exercising the rate gate.
  globalThis.fetch = async () => {
    throw new Error("network_disabled_for_rate_limit_test");
  };
  const headers = {
    host: "flux-ai-bio.netlify.app",
    origin: "https://flux-ai-bio.netlify.app",
    "x-nf-client-connection-ip": "203.0.113.99",
  };
  for (let i = 0; i < 30; i += 1) {
    const res = await handler(event({ headers }));
    assert.equal(res.statusCode, 200, `request ${i + 1}`);
  }
  const blocked = await handler(event({ headers }));
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body, /rate_limited/);
});

test("Netlify chat validates oversized payloads", async () => {
  delete process.env.GROQ_API_KEY;
  const res = await handler(
    event({
      body: JSON.stringify({
        messages: [{ role: "user", content: "x".repeat(4_001) }],
      }),
    }),
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /message_too_long/);
});

test("Netlify chat GET health is same-origin and does not burn rate budget", async () => {
  delete process.env.GROQ_API_KEY;
  globalThis.fetch = async () => {
    throw new Error("network_disabled_for_rate_limit_test");
  };
  const headers = {
    host: "flux-ai-bio.netlify.app",
    origin: "https://flux-ai-bio.netlify.app",
    "x-nf-client-connection-ip": "203.0.113.77",
  };
  for (let i = 0; i < 40; i += 1) {
    const health = await handler(
      event({
        httpMethod: "GET",
        headers,
        body: "",
      }),
    );
    assert.equal(health.statusCode, 200, `health ${i + 1}`);
    const body = JSON.parse(health.body);
    assert.equal(body.ok, true);
    assert.equal(body.groqConfigured, false);
  }
  // POST budget still available after many GET probes.
  const post = await handler(event({ headers }));
  assert.equal(post.statusCode, 200);
});
