/**
 * Cursor Apps chat route: GET/POST /api/chat
 * Uses Web Request/Response handlers. GROQ_API_KEY stays in process.env (server only).
 *
 * Netlify continues to use netlify/functions/chat.mjs — left intact during migration.
 */

import { chatHealth, handleScienceChat } from "../js/science-chat.mjs";

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function GET() {
  return json(200, chatHealth());
}

export async function POST(request) {
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  try {
    const result = await handleScienceChat(payload ?? {});
    const { status, ...body } = result;
    return json(status ?? (body.ok ? 200 : 500), body);
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "chat_failed",
    });
  }
}
