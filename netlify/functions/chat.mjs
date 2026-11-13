/**
 * Netlify Function: conversational science chat via Groq.
 * Uses GROQ_API_KEY from Netlify environment variables (server-side only).
 */

import { chatHealth, handleScienceChat } from "../../js/science-chat.mjs";

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  const method = event.httpMethod || "GET";

  if (method === "GET") {
    return json(200, chatHealth());
  }

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "private, no-store",
      },
      body: "",
    };
  }

  if (method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const result = await handleScienceChat(payload);
  const { status, ...body } = result;
  return json(status ?? (body.ok ? 200 : 500), body);
}
