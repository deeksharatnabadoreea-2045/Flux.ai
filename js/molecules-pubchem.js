/**
 * PubChem PUG helpers for the molecular explorer (search, profile, SDF).
 * Facts come from PubChem only — never invent formulas, weights, or IDs.
 */

const PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const PUG_VIEW = "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view";

const PROPERTY_FIELDS = [
  "MolecularFormula",
  "MolecularWeight",
  "IUPACName",
  "CanonicalSMILES",
  "ConnectivitySMILES",
  "InChIKey",
  "Title",
  "XLogP",
  "TPSA",
  "Complexity",
  "HBondDonorCount",
  "HBondAcceptorCount",
  "RotatableBondCount",
  "Charge",
].join(",");

/** Curated PubChem CIDs — real compounds only. */
export const FEATURED_MOLECULE_CIDS = [
  2519, // Caffeine
  2244, // Aspirin
  5957, // ATP
  3672, // Ibuprofen
  5793, // Glucose
  5280343, // Quercetin
  445154, // Resveratrol
  54670067, // Vitamin C
];

export const HERO_MOLECULE_CID = 2519;

export const FEATURED_FALLBACK = [
  {
    cid: 2519,
    name: "Caffeine",
    formula: "C8H10N4O2",
    molecularWeight: 194.19,
    iupacName: "1,3,7-trimethylpurine-2,6-dione",
    smiles: "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",
    inchiKey: "RYYVLZVUVIJVGH-UHFFFAOYSA-N",
    has3d: true,
  },
  {
    cid: 2244,
    name: "Aspirin",
    formula: "C9H8O4",
    molecularWeight: 180.16,
    iupacName: "2-acetyloxybenzoic acid",
    smiles: "CC(=O)OC1=CC=CC=C1C(=O)O",
    inchiKey: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    has3d: true,
  },
  {
    cid: 5957,
    name: "ATP",
    formula: "C10H16N5O13P3",
    molecularWeight: 507.18,
    has3d: true,
  },
  {
    cid: 3672,
    name: "Ibuprofen",
    formula: "C13H18O2",
    molecularWeight: 206.28,
    has3d: true,
  },
  {
    cid: 5793,
    name: "D-Glucose",
    formula: "C6H12O6",
    molecularWeight: 180.16,
    has3d: true,
  },
  {
    cid: 5280343,
    name: "Quercetin",
    formula: "C15H10O7",
    molecularWeight: 302.24,
    has3d: true,
  },
];

export const BIOLOGY_CATEGORIES = [
  {
    id: "molecules",
    label: "Molecules",
    href: "./explorer/molecules/",
    description:
      "Search, profile, and visualize molecular structures from scientific sources.",
    availability: "available",
    statusLabel: "Available",
  },
  {
    id: "proteins",
    label: "Proteins",
    href: "./explorer/proteins/",
    description:
      "Sequences, structures, and properties — module planned for a future release.",
    availability: "upcoming",
    statusLabel: "Upcoming",
  },
  {
    id: "nucleic-acids",
    label: "DNA & RNA",
    href: "./explorer/nucleic-acids/",
    description:
      "Genetic sequences and nucleic structures — module planned for a future release.",
    availability: "upcoming",
    statusLabel: "Upcoming",
  },
  {
    id: "cells",
    label: "Cells",
    href: "./explorer/cells/",
    description:
      "Cellular structures and systems — module planned for a future release.",
    availability: "upcoming",
    statusLabel: "Upcoming",
  },
  {
    id: "tissues",
    label: "Tissues",
    href: "./explorer/tissues/",
    description:
      "Tissue organization and context — module planned for a future release.",
    availability: "upcoming",
    statusLabel: "Upcoming",
  },
];

function num(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function mapSummary(p) {
  return {
    cid: p.CID,
    name: p.Title || p.IUPACName || `CID ${p.CID}`,
    formula: p.MolecularFormula,
    molecularWeight: num(p.MolecularWeight),
    iupacName: p.IUPACName,
    smiles: p.CanonicalSMILES || p.ConnectivitySMILES,
    inchiKey: p.InChIKey,
  };
}

function mapProperties(p) {
  const props = {};
  if (p.XLogP !== undefined) props.xlogp = p.XLogP;
  if (p.TPSA !== undefined) props.tpsa = p.TPSA;
  if (p.Complexity !== undefined) props.complexity = p.Complexity;
  if (p.HBondDonorCount !== undefined) props.hBondDonors = p.HBondDonorCount;
  if (p.HBondAcceptorCount !== undefined) props.hBondAcceptors = p.HBondAcceptorCount;
  if (p.RotatableBondCount !== undefined) props.rotatableBonds = p.RotatableBondCount;
  if (p.Charge !== undefined) props.charge = p.Charge;
  return props;
}

async function fetchJson(url, init) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function searchMolecules(query, limit = 12) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const exact = await fetchJson(
    `${PUG}/compound/name/${encodeURIComponent(q)}/cids/JSON`,
  );
  const word = await fetchJson(
    `${PUG}/compound/name/${encodeURIComponent(q)}/cids/JSON?name_type=word`,
  );

  const seen = new Set();
  const cids = [];
  for (const cid of [
    ...(exact?.IdentifierList?.CID ?? []),
    ...(word?.IdentifierList?.CID ?? []),
  ]) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    cids.push(cid);
    if (cids.length >= limit) break;
  }

  if (!cids.length) return [];
  return getMoleculesByCids(cids);
}

export async function getMoleculesByCids(cids) {
  if (!cids.length) return [];
  const url = `${PUG}/compound/cid/${cids.join(",")}/property/${PROPERTY_FIELDS}/JSON`;
  const data = await fetchJson(url);
  const props = data?.PropertyTable?.Properties ?? [];
  return props.map(mapSummary);
}

export async function getFeaturedMolecules() {
  const live = await getMoleculesByCids([...FEATURED_MOLECULE_CIDS]);
  if (!live.length) return FEATURED_FALLBACK;

  const byCid = new Map(FEATURED_FALLBACK.map((m) => [m.cid, m]));
  return live.map((m) => {
    const curated = byCid.get(m.cid);
    if (!curated?.name) return m;
    return { ...m, name: curated.name };
  });
}

export async function checkStructure3d(cid) {
  try {
    const get = await fetch(`${PUG}/compound/cid/${cid}/SDF?record_type=3d`);
    if (!get.ok) return false;
    const text = await get.text();
    return Boolean(text?.trim()) && !text.includes('"Status": 404');
  } catch {
    return false;
  }
}

export async function getMoleculeStructureSdf(cid) {
  try {
    const res3d = await fetch(`${PUG}/compound/cid/${cid}/SDF?record_type=3d`);
    if (res3d.ok) {
      const text = await res3d.text();
      if (text && !text.includes('Status":404')) return text;
    }
    const res2d = await fetch(`${PUG}/compound/cid/${cid}/SDF`);
    if (!res2d.ok) return null;
    const text = await res2d.text();
    return text && !text.includes('Status":404') ? text : null;
  } catch {
    return null;
  }
}

async function getDescription(cid) {
  const data = await fetchJson(
    `${PUG_VIEW}/data/compound/${cid}/JSON?heading=Record+Description`,
  );
  const sections = data?.Record?.Section ?? [];
  for (const section of sections) {
    const info = section.Information?.[0]?.Value?.StringWithMarkup?.[0]?.String;
    if (info) return info;
    for (const nested of section.Section ?? []) {
      const nestedInfo =
        nested.Information?.[0]?.Value?.StringWithMarkup?.[0]?.String;
      if (nestedInfo) return nestedInfo;
    }
  }
  return undefined;
}

async function getSynonyms(cid, limit = 8) {
  const data = await fetchJson(`${PUG}/compound/cid/${cid}/synonyms/JSON`);
  const synonyms = data?.InformationList?.Information?.[0]?.Synonym ?? [];
  return synonyms.slice(0, limit);
}

export async function getMoleculeProfile(cid) {
  const summaries = await getMoleculesByCids([cid]);
  const summary = summaries[0];
  if (!summary) {
    const fallback = FEATURED_FALLBACK.find((m) => m.cid === cid);
    if (!fallback) return null;
    return {
      ...fallback,
      synonyms: [],
      properties: {},
      references: [
        {
          label: "PubChem",
          url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
        },
      ],
      structureAvailable: Boolean(fallback.has3d),
    };
  }

  const [synonyms, description, has3d, sdf, propRaw] = await Promise.all([
    getSynonyms(cid),
    getDescription(cid),
    checkStructure3d(cid),
    getMoleculeStructureSdf(cid),
    fetchJson(
      `${PUG}/compound/cid/${cid}/property/${PROPERTY_FIELDS}/JSON`,
    ),
  ]);

  const raw = propRaw?.PropertyTable?.Properties?.[0];
  const properties = raw ? mapProperties(raw) : {};

  return {
    ...summary,
    has3d,
    synonyms,
    description,
    properties,
    references: [
      {
        label: "PubChem Compound",
        url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
      },
    ],
    structureAvailable: Boolean(sdf),
  };
}

export function parseCid(value) {
  const cid = Number(value);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  return cid;
}
