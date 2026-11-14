import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DEFAULT_GROQ_MODEL,
  resolveGroqConfig,
  pubchemOnlyReply,
  handleScienceChat,
} from "./science-chat.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalModel = process.env.GROQ_MODEL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.GROQ_MODEL;
  else process.env.GROQ_MODEL = originalModel;
});

test("resolveGroqConfig reads GROQ_API_KEY", () => {
  const cfg = resolveGroqConfig({ GROQ_API_KEY: "gsk_test", GROQ_MODEL: "openai/gpt-oss-20b" });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.model, "openai/gpt-oss-20b");
  assert.match(cfg.apiBase, /api\.groq\.com/);
});

test("resolveGroqConfig defaults to a current Groq production model", () => {
  const cfg = resolveGroqConfig({ GROQ_API_KEY: "gsk_test" });
  assert.equal(cfg.model, DEFAULT_GROQ_MODEL);
  assert.equal(cfg.model, "openai/gpt-oss-120b");
  assert.ok(cfg.modelCandidates.includes("openai/gpt-oss-20b"));
});

test("resolveGroqConfig is off without a key", () => {
  assert.equal(resolveGroqConfig({}).configured, false);
});

test("handleScienceChat falls back when preferred Groq model is retired", async () => {
  process.env.GROQ_API_KEY = "gsk_test";
  process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
  const modelsTried = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes("api.groq.com")) {
      throw new Error(`unexpected fetch ${href}`);
    }
    const body = JSON.parse(options.body || "{}");
    modelsTried.push(body.model);
    if (body.model === "llama-3.3-70b-versatile") {
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: {
              message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.",
              code: "model_not_found",
            },
          }),
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "Glucose is your cells' main quick fuel — a sugar your body uses for energy.",
              },
            },
          ],
        }),
      json: async () => ({}),
    };
  };

  const result = await handleScienceChat({
    messages: [{ role: "user", content: "Why does my body need glucose?" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.groqConfigured, true);
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.match(result.reply, /quick fuel|energy/i);
  assert.doesNotMatch(result.reply, /temporarily unavailable/i);
  assert.deepEqual(modelsTried.slice(0, 2), [
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
  ]);
});

test("pubchemOnlyReply returns glucose facts without Groq", async () => {
  delete process.env.GROQ_API_KEY;
  const result = await pubchemOnlyReply("glucose");
  assert.ok(result.molecule);
  assert.equal(result.molecule.formula, "C6H12O6");
  assert.match(result.reply, /glucose/i);
});

test("handleScienceChat uses Groq when key is set (mocked)", async () => {
  process.env.GROQ_API_KEY = "gsk_test";
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("api.groq.com")) {
      const body = JSON.parse(options.body || "{}");
      const last = body.messages?.[body.messages.length - 1];
      // First turn: request a tool call; later turns: plain answer.
      const hasToolResult = body.messages?.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "lookup_human_molecule",
                          arguments: JSON.stringify({ name: "water" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "Water is essential in the human body. PubChem lists formula H2O.",
                },
              },
            ],
          }),
        json: async () => ({}),
      };
    }
    // PubChem / ChEBI / HMDB paths used by lookupMolecule
    if (href.includes("/property/MolecularFormula")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          PropertyTable: {
            Properties: [{ CID: 962, MolecularFormula: "H2O", MolecularWeight: "18.015" }],
          },
        }),
      };
    }
    if (href.includes("/synonyms/JSON")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InformationList: { Information: [{ CID: 962, Synonym: ["CHEBI:15377"] }] },
        }),
      };
    }
    if (href.includes("heading=HMDB%20ID")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Record: {
            Section: [{ Information: [{ Value: { StringWithMarkup: [{ String: "HMDB0002111" }] } }] }],
          },
        }),
      };
    }
    if (href.includes("/chebi/backend/api/public/compound/15377/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          roles_classification: { name: "human metabolite" },
          compound_origins: [],
        }),
      };
    }
    throw new Error(`Unexpected URL ${href} last=${last?.content}`);
  };

  const result = await handleScienceChat({ message: "What is water?" });
  assert.equal(result.ok, true);
  assert.equal(result.groqConfigured, true);
  assert.match(result.reply, /Water|H2O/i);
  assert.ok(result.molecule);
  assert.equal(result.molecule.formula, "H2O");
});
