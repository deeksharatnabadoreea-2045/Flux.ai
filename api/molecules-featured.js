/**
 * Cursor Apps: GET /api/molecules-featured
 * Featured molecule list for explorer (PubChem live + curated names).
 */

import {
  cachedMoleculeFetch,
  moleculeRateLimitResponse,
} from "../js/molecules-api.mjs";
import { getFeaturedMolecules } from "../js/molecules-pubchem.js";

export async function GET(request) {
  const limited = moleculeRateLimitResponse(request);
  if (limited) return limited;

  try {
    const results = await cachedMoleculeFetch("featured", 10 * 60_000, () =>
      getFeaturedMolecules(),
    );
    return Response.json(
      { results },
      { headers: { "cache-control": "public, max-age=600" } },
    );
  } catch {
    return Response.json(
      { error: "Featured fetch failed", results: [] },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    );
  }
}
