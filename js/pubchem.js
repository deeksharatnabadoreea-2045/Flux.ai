/** PubChem PUG REST helpers for compound name lookups. */

const PUBCHEM_PROPERTY_URL =
  "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/property/MolecularFormula,MolecularWeight/JSON";

/**
 * Fetch MolecularFormula + MolecularWeight for a compound name.
 * @param {string} name
 * @returns {Promise<{ name: string, formula: string, molecularWeight: string, cid: number } | null>}
 */
export async function lookupMolecule(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;

  const url = PUBCHEM_PROPERTY_URL.replace("{name}", encodeURIComponent(trimmed));
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`PubChem HTTP ${res.status}`);
  }

  const data = await res.json();
  const props = data?.PropertyTable?.Properties?.[0];
  if (!props?.MolecularFormula || props.MolecularWeight == null) return null;

  return {
    name: trimmed,
    formula: String(props.MolecularFormula),
    molecularWeight: String(props.MolecularWeight),
    cid: Number(props.CID),
  };
}
