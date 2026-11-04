import { forceDailyCoScientistSync } from "../../js/co-scientist-server.mjs";

/** Runs once per day on Netlify; merges new PubMed / UniProt / AlphaFold into blob archive. */
export async function handler() {
  try {
    const result = await forceDailyCoScientistSync(process.cwd());
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        added: result.added ?? 0,
        archiveSize: result.archive?.items?.length ?? 0,
        lastDailySyncAt: result.archive?.lastDailySyncAt ?? null,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "daily_sync_failed",
      }),
    };
  }
}

export const config = {
  schedule: "@daily",
};
