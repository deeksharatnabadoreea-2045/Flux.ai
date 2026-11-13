/**
 * Evidence gate for molecules that naturally occur in humans.
 *
 * PubChem remains the compound identity / property source. This module only
 * decides whether Flux should *display* a compound in the human molecule
 * library, using human-focused databases linked from PubChem:
 *
 *   1. ChEBI (via PubChem CHEBI: synonyms) — "human … metabolite" roles and
 *      compound_origins that cite Homo sapiens with a literature source.
 *   2. HMDB IDs exposed on the PubChem record — used only together with a
 *      ChEBI mammalian / fundamental metabolite role when the primary ChEBI
 *      entry lacks an explicit human role (charge / tautomer mismatches).
 *
 * Fail closed: no reliable human evidence ⇒ not included. Never invents data.
 */

const PUBCHEM_SYNONYMS_URL =
  "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/synonyms/JSON";
const PUBCHEM_HMDB_ID_URL =
  "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/{cid}/JSON?heading=HMDB%20ID";
const CHEBI_COMPOUND_URL =
  "https://www.ebi.ac.uk/chebi/backend/api/public/compound/{id}/";

const HUMAN_METABOLITE_ROLE_RE = /human.*metabolite|metabolite.*human/i;
const MAMMALIAN_PROXY_ROLES = new Set([
  "fundamental metabolite",
  "mammalian metabolite",
  "mouse metabolite",
  "rat metabolite",
]);

const MAX_CHEBI_LOOKUPS = 6;

/**
 * @typedef {{
 *   occursInHumans: boolean,
 *   reason: string,
 *   hmdbIds: string[],
 *   chebiIds: string[],
 *   humanRoles: string[],
 *   proxyRoles: string[],
 *   humanOriginSources: Array<{ species: string, source: string, sourceAccession: string, chebiId: string }>,
 * }} HumanOccurrenceEvidence
 */

/**
 * @param {number|string} cid
 * @returns {Promise<string[]>} ChEBI numeric ids (no prefix)
 */
export async function fetchChebiIdsForCid(cid) {
  const url = PUBCHEM_SYNONYMS_URL.replace("{cid}", encodeURIComponent(String(cid)));
  const res = await fetch(url);
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`PubChem synonym lookup failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const synonyms = data?.InformationList?.Information?.[0]?.Synonym ?? [];
  const ids = [];
  const seen = new Set();
  for (const syn of synonyms) {
    const m = /^CHEBI:(\d+)$/i.exec(String(syn));
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }
  return ids;
}

/**
 * Collect HMDB accession strings from the PubChem "HMDB ID" annotation.
 * @param {number|string} cid
 * @returns {Promise<string[]>}
 */
export async function fetchHmdbIdsForCid(cid) {
  const url = PUBCHEM_HMDB_ID_URL.replace("{cid}", encodeURIComponent(String(cid)));
  const res = await fetch(url);
  if (res.status === 404 || res.status === 400) return [];
  if (!res.ok) {
    throw new Error(`PubChem HMDB ID lookup failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const ids = [];
  const seen = new Set();
  walkStrings(data, (value) => {
    const m = /^(HMDB\d+)$/i.exec(value);
    if (!m) return;
    const normalized = m[1].toUpperCase().replace(/^HMDB/, "HMDB");
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ids.push(normalized);
  });
  return ids;
}

/**
 * @param {string} chebiId numeric id
 * @returns {Promise<object>}
 */
export async function fetchChebiCompound(chebiId) {
  const url = CHEBI_COMPOUND_URL.replace("{id}", encodeURIComponent(String(chebiId)));
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) {
    throw new Error(`ChEBI compound ${chebiId} not found.`);
  }
  if (!res.ok) {
    throw new Error(`ChEBI request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

/**
 * Score a single ChEBI record for human occurrence signals.
 * @param {object} record
 * @param {string} chebiId
 */
export function extractChebiHumanSignals(record, chebiId) {
  const roleNames = [];
  walkRoleNames(record?.roles_classification, roleNames);

  const humanRoles = roleNames.filter((name) => HUMAN_METABOLITE_ROLE_RE.test(name));
  const proxyRoles = roleNames.filter((name) =>
    MAMMALIAN_PROXY_ROLES.has(String(name).toLowerCase()),
  );

  const humanOriginSources = [];
  for (const origin of record?.compound_origins ?? []) {
    if (!isHomoSapiensOrigin(origin)) continue;
    humanOriginSources.push({
      species: String(origin.species_text ?? "Homo sapiens"),
      source: String(origin.source ?? ""),
      sourceAccession: String(origin.source_accession ?? ""),
      chebiId: String(chebiId),
    });
  }

  return { humanRoles, proxyRoles, humanOriginSources };
}

/**
 * Decide whether evidence supports natural / documented presence in humans.
 * @param {{
 *   hmdbIds?: string[],
 *   chebiSignals?: Array<{ humanRoles: string[], proxyRoles: string[], humanOriginSources: object[] }>,
 *   chebiIds?: string[],
 * }} parts
 * @returns {HumanOccurrenceEvidence}
 */
export function evaluateHumanOccurrence(parts = {}) {
  const hmdbIds = [...new Set(parts.hmdbIds ?? [])];
  const chebiIds = [...new Set(parts.chebiIds ?? [])];
  const signals = parts.chebiSignals ?? [];

  const humanRoles = unique(
    signals.flatMap((s) => s.humanRoles ?? []),
  );
  const proxyRoles = unique(
    signals.flatMap((s) => s.proxyRoles ?? []),
  );
  const humanOriginSources = signals.flatMap((s) => s.humanOriginSources ?? []);

  const chebiHuman =
    humanRoles.length > 0 || humanOriginSources.length > 0;
  const hmdbWithMammalianProxy = hmdbIds.length > 0 && proxyRoles.length > 0;

  const occursInHumans = chebiHuman || hmdbWithMammalianProxy;

  let reason = "insufficient_evidence";
  if (chebiHuman && hmdbWithMammalianProxy) {
    reason = "chebi_human_and_hmdb_mammalian_proxy";
  } else if (chebiHuman) {
    reason = "chebi_human";
  } else if (hmdbWithMammalianProxy) {
    reason = "hmdb_and_mammalian_proxy";
  }

  return {
    occursInHumans,
    reason,
    hmdbIds,
    chebiIds,
    humanRoles,
    proxyRoles,
    humanOriginSources,
  };
}

/**
 * Verify a PubChem CID against ChEBI + HMDB annotations.
 * @param {number|string} cid
 * @returns {Promise<HumanOccurrenceEvidence>}
 */
export async function verifyHumanOccurrence(cid) {
  if (cid == null || Number.isNaN(Number(cid))) {
    return evaluateHumanOccurrence({});
  }

  const [chebiIds, hmdbIds] = await Promise.all([
    fetchChebiIdsForCid(cid),
    fetchHmdbIdsForCid(cid),
  ]);

  const chebiSignals = [];
  for (const id of chebiIds.slice(0, MAX_CHEBI_LOOKUPS)) {
    try {
      const record = await fetchChebiCompound(id);
      chebiSignals.push(extractChebiHumanSignals(record, id));
    } catch {
      // Skip unreachable / missing ChEBI entries; other ids may still qualify.
    }
  }

  return evaluateHumanOccurrence({ hmdbIds, chebiIds, chebiSignals });
}

function isHomoSapiensOrigin(origin) {
  const species = String(origin?.species_text ?? "").trim().toLowerCase();
  const accession = String(origin?.species_accession ?? "").trim();
  return (
    species === "homo sapiens" ||
    species === "human" ||
    accession === "9606" ||
    accession.endsWith(":9606")
  );
}

function walkRoleNames(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walkRoleNames(child, acc);
    return;
  }
  if (typeof node === "object") {
    if (typeof node.name === "string" && node.name.trim()) {
      acc.push(node.name.trim());
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walkRoleNames(value, acc);
    }
  }
}

function walkStrings(node, visit) {
  if (node == null) return;
  if (typeof node === "string") {
    visit(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walkStrings(child, visit);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) walkStrings(value, visit);
  }
}

function unique(items) {
  return [...new Set(items.map((x) => String(x)))];
}
