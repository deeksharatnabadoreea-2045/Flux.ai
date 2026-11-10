/** PubChem PUG REST helpers for compound name lookups. */

const PUBCHEM_PROPERTY_URL =
  "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{query}/property/MolecularFormula,MolecularWeight/json";

/**
 * Fetch MolecularFormula + MolecularWeight for a compound name.
 * @param {string} query
 * @returns {Promise<{ name: string, formula: string, molecularWeight: string, cid: number }>}
 */
export async function lookupMolecule(query) {
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

  return {
    name: trimmed,
    formula: String(props.MolecularFormula),
    molecularWeight: String(props.MolecularWeight),
    cid: Number(props.CID),
  };
}
