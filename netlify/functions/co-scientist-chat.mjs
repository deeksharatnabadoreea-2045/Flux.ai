import { buildCoScientistFeed } from "../../js/co-scientist-feed.mjs";
import { buildCoScientistReply } from "../../js/co-scientist-chat.mjs";

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
    const message = String(payload.message ?? "").trim();
    if (!message) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "message_required" }),
      };
    }
    let feed = payload.feed;
    if (!feed?.items?.length) feed = await buildCoScientistFeed();
    const profile = payload.feedbackProfile ?? { verbosity: "balanced" };
    const reply = buildCoScientistReply({ message, feed, feedbackProfile: profile });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        reply,
        feedFetchedAt: feed.fetchedAt,
        feedbackProfile: profile,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "chat_failed",
      }),
    };
  }
}
