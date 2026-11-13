import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  resolveGroqConfig,
  pubchemOnlyReply,
  handleScienceChat,
} from "./science-chat.mjs";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GROQ_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
});

test("resolveGroqConfig reads GROQ_API_KEY", () => {
  const cfg = resolveGroqConfig({ GROQ_API_KEY: "gsk_test", GROQ_MODEL: "llama-3.1-8b-instant" });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.model, "llama-3.1-8b-instant");
  assert.match(cfg.apiBase, /api\.groq\.com/);
});

test("resolveGroqConfig is off without a key", () => {
  assert.equal(resolveGroqConfig({}).configured, false);
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
