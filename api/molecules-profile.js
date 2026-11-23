/**
 * Cursor Apps: GET /api/molecules-profile?cid=
 * Public PubChem molecule profile for the explorer.
 */

import {
  getMoleculeProfile,
  parseCid,
} from "../js/molecules-pubchem.js";

function json(status, body) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": status === 200 ? "public, max-age=600" : "private, no-store",
    },
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const cid = parseCid(url.searchParams.get("cid"));
  if (!cid) return json(400, { error: "Invalid CID" });

  try {
    const profile = await getMoleculeProfile(cid);
    if (!profile) return json(404, { error: "Molecule not found" });
    return json(200, { profile });
  } catch {
    return json(502, { error: "Profile fetch failed" });
  }
}
