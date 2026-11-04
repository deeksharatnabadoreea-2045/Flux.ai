import {
  emptyFeedbackState,
  normalizeFeedbackState,
  recordFeedback,
  profileFromFeedback,
} from "../../js/co-scientist-feedback.mjs";

/** Netlify serverless has ephemeral FS — persist profile in response; client keeps canonical copy. */
let memoryState = emptyFeedbackState();

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "method_not_allowed" }),
    };
  }
  try {
    const payload = JSON.parse(event.body || "{}");
    if (payload.syncState) {
      memoryState = normalizeFeedbackState(payload.syncState);
    }
    memoryState = recordFeedback(memoryState, {
      messageId: payload.messageId,
      rating: payload.rating,
      intents: payload.intents ?? [],
    });
    const profile = profileFromFeedback(memoryState);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, profile, state: memoryState }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "feedback_failed",
      }),
    };
  }
}
