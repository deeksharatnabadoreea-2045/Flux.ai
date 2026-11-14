/**
 * Server-side conversational science chat via Groq.
 * Reads GROQ_API_KEY from the environment only — never ship this to the browser.
 */

import { randomUUID } from "node:crypto";
import { safeChatProviderError } from "./chat-guard.mjs";
import { lookupMolecule } from "./pubchem.js";

export const SYSTEM_PROMPT = `You are Flux, a friendly conversational science assistant about the human body and its molecules.

Rules:
- Speak in clear, natural English. Explain simply and use short examples when helpful.
- Remember conversation context so pronouns like "it" refer to the molecule already discussed.
- Do not invent scientific formulas, molecular weights, or database IDs.
- When the user asks about a chemical molecule (identity, formula, weight, composition), call lookup_human_molecule and use only that tool result for those facts.
- If the tool says a compound is not in the human molecule library, say so clearly.
- Ask at most one short follow-up question when it helps learning.
- You are not a doctor; avoid medical advice or dosing.`;

const LOOKUP_TOOL = {
  type: "function",
  function: {
    name: "lookup_human_molecule",
    description:
      "Look up a compound on PubChem. Only returns compounds with ChEBI/HMDB evidence of natural occurrence or documented presence in humans.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description: "Compound name, e.g. glucose, water, urea",
        },
      },
      required: ["name"],
    },
  },
};

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const MAX_HISTORY = 24;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveGroqConfig(env = process.env) {
  const apiKey = String(env.GROQ_API_KEY ?? "").trim();
  if (!apiKey) {
    return { configured: false, apiKey: "", model: "", apiBase: GROQ_API_BASE };
  }
  return {
    configured: true,
    apiKey,
    model: String(env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL,
    apiBase: String(env.GROQ_API_BASE ?? GROQ_API_BASE).replace(/\/$/, ""),
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content ?? "").trim(),
    }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY);
}

function formatEvidenceSummary(molecule) {
  const evidence = molecule?.humanEvidence;
  if (!evidence?.occursInHumans) return "";
  const parts = [];
  if (evidence.hmdbIds?.length) parts.push(`HMDB ${evidence.hmdbIds.slice(0, 2).join(", ")}`);
  if (evidence.chebiIds?.length) {
    parts.push(evidence.chebiIds.slice(0, 2).map((id) => `ChEBI:${id}`).join(", "));
  }
  if (evidence.humanRoles?.[0]) parts.push(evidence.humanRoles[0]);
  else if (evidence.proxyRoles?.[0]) parts.push(evidence.proxyRoles[0]);
  return parts.join(" · ");
}

async function runLookupTool(name) {
  try {
    const molecule = await lookupMolecule(name);
    return {
      ok: true,
      molecule,
      summary: {
        name: molecule.name,
        formula: molecule.formula,
        molecularWeight: molecule.molecularWeight,
        cid: molecule.cid,
        humanEvidence: formatEvidenceSummary(molecule),
        pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${molecule.cid}`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "lookup_failed",
    };
  }
}

async function callGroq(config, body) {
  const res = await fetch(`${config.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Groq returned non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`Groq request failed: ${detail}`);
  }
  return data;
}

function extractToolCalls(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => {
      let args = {};
      try {
        args = JSON.parse(call?.function?.arguments || "{}");
      } catch {
        args = {};
      }
      return {
        id: call.id || randomUUID(),
        name: call?.function?.name,
        args,
      };
    })
    .filter((c) => c.name);
}

/**
 * Infer a compound name from the latest user text + prior turns (for no-Groq fallback).
 */
export function inferMoleculeQuery(message, messages = []) {
  const name = String(message ?? "").trim();
  if (!name) return "";

  const priorFocus = [...messages]
    .reverse()
    .map((m) => String(m?.content ?? ""))
    .map((text) => {
      const asked = text.match(/^what(?:'s| is)\s+([A-Za-z][A-Za-z0-9+\-]{1,40})\??$/i);
      if (asked) return asked[1];
      const hit = text.match(
        /^([A-Za-z][A-Za-z0-9+\-]{1,40}):\s*formula\b/i,
      );
      if (hit) return hit[1];
      const bare = text.match(/^([A-Za-z][A-Za-z0-9+\-]{1,40})$/);
      return bare?.[1] ?? "";
    })
    .find(Boolean);

  if (priorFocus && /\b(it|this|that|its|it's)\b/i.test(name)) {
    return priorFocus;
  }
  if (priorFocus && /(?:made of|formula|weight|mass|atoms|composed|need)/i.test(name)) {
    return priorFocus;
  }

  const m = name.match(/^what(?:'s| is)\s+(.+?)\??$/i);
  if (m) {
    const candidate = m[1].trim();
    if (!/^(it|this|that)\b/i.test(candidate)) return candidate;
    return priorFocus || "";
  }

  if (/^[A-Za-z][A-Za-z0-9+\-]*(?:[ ][A-Za-z][A-Za-z0-9+\-]*){0,3}$/.test(name)) {
    return name;
  }
  return "";
}

/**
 * PubChem-only fallback when Groq is not configured (keeps molecule search working).
 */
export async function pubchemOnlyReply(message, messages = []) {
  const name = String(message ?? "").trim();
  if (!name) {
    return { reply: "Send a message to start chatting.", molecule: null };
  }
  const query = inferMoleculeQuery(name, messages);
  if (!query) {
    return {
      reply:
        "Conversational AI is not configured on this server yet. You can still look up a human molecule by name (e.g. glucose).",
      molecule: null,
    };
  }
  const result = await runLookupTool(query);
  if (!result.ok) {
    return { reply: result.error, molecule: null };
  }
  const mol = result.molecule;
  const evidence = formatEvidenceSummary(mol);
  return {
    reply: `${mol.name}: formula ${mol.formula}, molecular weight ${mol.molecularWeight} (PubChem CID ${mol.cid}).${evidence ? ` Human evidence: ${evidence}.` : ""} Full conversational replies need the Groq key configured on the server.`,
    molecule: mol,
  };
}

async function replyWithGroq({ messages, config }) {
  const history = normalizeMessages(messages);
  const apiMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];

  let molecule = null;
  let data = await callGroq(config, {
    model: config.model,
    messages: apiMessages,
    tools: [LOOKUP_TOOL],
    tool_choice: "auto",
    temperature: 0.5,
  });

  for (let round = 0; round < 3; round += 1) {
    const choice = data?.choices?.[0]?.message;
    const toolCalls = extractToolCalls(choice);
    if (!toolCalls.length) {
      return {
        reply: String(choice?.content ?? "").trim() || "I could not generate a reply. Try again.",
        molecule,
      };
    }

    apiMessages.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: choice.tool_calls,
    });

    for (const call of toolCalls) {
      if (call.name !== "lookup_human_molecule") {
        apiMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: "unknown_tool" }),
        });
        continue;
      }
      const result = await runLookupTool(String(call.args?.name ?? ""));
      if (result.ok) molecule = result.molecule;
      apiMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.ok ? { ok: true, ...result.summary } : result),
      });
    }

    data = await callGroq(config, {
      model: config.model,
      messages: apiMessages,
      tools: [LOOKUP_TOOL],
      tool_choice: "auto",
      temperature: 0.5,
    });
  }

  return {
    reply:
      String(data?.choices?.[0]?.message?.content ?? "").trim() ||
      "Please try a more specific question.",
    molecule,
  };
}

/**
 * @param {{
 *   message?: string,
 *   messages?: Array<{role: string, content: string}>,
 *   conversationId?: string,
 * }} input
 */
export async function handleScienceChat(input = {}) {
  const config = resolveGroqConfig();
  const conversationId = String(input.conversationId ?? "").trim() || randomUUID();

  let messages = normalizeMessages(input.messages);
  const single = String(input.message ?? "").trim();
  if (single) messages = [...messages, { role: "user", content: single }];
  if (!messages.length) {
    return { ok: false, status: 400, error: "message_required", conversationId };
  }

  let result;
  try {
    if (config.configured) {
      result = await replyWithGroq({ messages, config });
    } else {
      const latest = messages[messages.length - 1]?.content ?? "";
      result = await pubchemOnlyReply(latest, messages.slice(0, -1));
    }
  } catch (err) {
    const latest = messages[messages.length - 1]?.content ?? "";
    const fallback = await pubchemOnlyReply(latest, messages.slice(0, -1));
    result = {
      reply: `${fallback.reply}\n\n(${safeChatProviderError(err)})`,
      molecule: fallback.molecule,
    };
  }

  const nextMessages = [
    ...messages,
    { role: "assistant", content: result.reply },
  ].slice(-MAX_HISTORY);

  return {
    ok: true,
    status: 200,
    conversationId,
    reply: result.reply,
    groqConfigured: config.configured,
    model: config.configured ? config.model : null,
    molecule: result.molecule
      ? {
          name: result.molecule.name,
          formula: result.molecule.formula,
          molecularWeight: result.molecule.molecularWeight,
          cid: result.molecule.cid,
          humanEvidence: result.molecule.humanEvidence ?? null,
          evidenceSummary: formatEvidenceSummary(result.molecule),
        }
      : null,
    messages: nextMessages,
  };
}

export function chatHealth() {
  const config = resolveGroqConfig();
  return {
    ok: true,
    groqConfigured: config.configured,
    model: config.configured ? config.model : null,
  };
}
