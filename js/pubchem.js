/** PubChem PUG REST helpers for compound name lookups. */

import { verifyHumanOccurrence } from "./human-molecule.js";

const PUBCHEM_PROPERTY_URL =
  "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{query}/property/MolecularFormula,MolecularWeight/json";

/**
 * Fetch MolecularFormula + MolecularWeight for a compound name from PubChem,
 * then admit it to the human molecule library only when ChEBI / HMDB evidence
 * supports natural occurrence (or documented presence) in humans.
 *
 * @param {string} query
 * @param {{ requireHumanOccurrence?: boolean }} [options]
 * @returns {Promise<{
 *   name: string,
 *   formula: string,
 *   molecularWeight: string,
 *   cid: number,
 *   humanEvidence: import("./human-molecule.js").HumanOccurrenceEvidence,
 * }>}
 */
export async function lookupMolecule(query, options = {}) {
  const requireHumanOccurrence = options.requireHumanOccurrence !== false;
  const trimmed = String(query ?? "").trim();
  if (!trimmed) {
    throw new Error("Enter a compound name to search.");
  }

  const url = PUBCHEM_PROPERTY_URL.replace("{query}", encodeURIComponent(trimmed));
  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error(`No PubChem compound found for “${trimmed}”.`);
  }
  if (!res.ok) {
    throw new Error(`PubChem request failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  const props = data?.PropertyTable?.Properties?.[0];
  if (!props?.MolecularFormula || props.MolecularWeight == null) {
    throw new Error(`PubChem returned incomplete data for “${trimmed}”.`);
  }

  const cid = Number(props.CID);
  const molecule = {
    name: trimmed,
    formula: String(props.MolecularFormula),
    molecularWeight: String(props.MolecularWeight),
    cid,
  };

  if (!requireHumanOccurrence) {
    return molecule;
  }

  let humanEvidence;
  try {
    humanEvidence = await verifyHumanOccurrence(cid);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    throw new Error(
      `Found “${trimmed}” in PubChem (CID ${cid}), but could not verify human occurrence (${detail}).`,
    );
  }

  if (!humanEvidence.occursInHumans) {
    throw new Error(
      `“${trimmed}” is in PubChem (CID ${cid}) but is not included in the human molecule library: no reliable ChEBI/HMDB evidence that it occurs naturally in humans.`,
    );
  }

  return { ...molecule, humanEvidence };
}
