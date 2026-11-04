import { buildCoScientistFeed } from "../../js/co-scientist-feed.mjs";

export async function handler() {
  try {
    const feed = await buildCoScientistFeed();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify({ ok: true, ...feed }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "feed_failed",
      }),
    };
  }
}
