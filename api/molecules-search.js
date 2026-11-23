/**
 * Cursor Apps: GET /api/molecules-search?q=
 * Public PubChem name search for the molecular explorer.
 */

import {
  cachedMoleculeFetch,
  MOLECULE_MAX_QUERY_CHARS,
  moleculeRateLimitResponse,
} from "../js/molecules-api.mjs";
import { searchMolecules } from "../js/molecules-pubchem.js";

function json(status, body, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": status === 200 ? "public, max-age=300" : "private, no-store",
      ...extraHeaders,
    },
  });
}

export async function GET(request) {
  const limited = moleculeRateLimitResponse(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json(200, { results: [] });
  if (q.length > MOLECULE_MAX_QUERY_CHARS) {
    return json(400, { error: "Query too long", results: [] });
  }

  try {
    const cacheKey = `search:${q.toLowerCase()}`;
    const results = await cachedMoleculeFetch(cacheKey, 5 * 60_000, () =>
      searchMolecules(q, 16),
    );
    return json(200, { results });
  } catch {
    return json(502, { error: "Search failed", results: [] });
  }
}
