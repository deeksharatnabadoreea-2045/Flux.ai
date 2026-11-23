/**
 * Cursor Apps: GET /api/molecules-search?q=
 * Public PubChem name search for the molecular explorer.
 */

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
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json(200, { results: [] });
  if (q.length > 120) return json(400, { error: "Query too long", results: [] });

  try {
    const results = await searchMolecules(q, 16);
    return json(200, { results });
  } catch {
    return json(502, { error: "Search failed", results: [] });
  }
}
