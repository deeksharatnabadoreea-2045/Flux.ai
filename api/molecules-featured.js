/**
 * Cursor Apps: GET /api/molecules-featured
 * Featured molecule list for explorer (PubChem live + curated names).
 */

import { getFeaturedMolecules } from "../js/molecules-pubchem.js";

export async function GET() {
  try {
    const results = await getFeaturedMolecules();
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
