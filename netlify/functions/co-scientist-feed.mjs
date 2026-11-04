import { getCoScientistFeed } from "../../js/co-scientist-server.mjs";

export async function handler(event) {
  try {
    const refresh = event?.queryStringParameters?.refresh === "1";
    const feed = await getCoScientistFeed(process.cwd(), { refresh });
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
