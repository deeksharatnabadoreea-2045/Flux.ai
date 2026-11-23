/**
 * Cursor Apps: GET /api/molecules-structure?cid=
 * Returns SDF text for 3Dmol (PubChem 3D preferred, 2D fallback).
 */

import {
  cachedMoleculeFetch,
  moleculeRateLimitResponse,
} from "../js/molecules-api.mjs";
import {
  getMoleculeStructureSdf,
  parseCid,
} from "../js/molecules-pubchem.js";

export async function GET(request) {
  const limited = moleculeRateLimitResponse(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const cid = parseCid(url.searchParams.get("cid"));
  if (!cid) {
    return Response.json(
      { error: "Invalid CID" },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }

  try {
    const sdf = await cachedMoleculeFetch(`sdf:${cid}`, 24 * 60 * 60_000, () =>
      getMoleculeStructureSdf(cid),
    );
    if (!sdf) {
      return Response.json(
        { error: "Structure unavailable" },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    }
    return new Response(sdf, {
      headers: {
        "Content-Type": "chemical/x-mdl-sdfile; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return Response.json(
      { error: "Structure fetch failed" },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    );
  }
}
