/**
 * Official-identifier gates for Flux science claims.
 * Never fabricates DOIs/PMIDs — only extracts and shape-checks, or verifies
 * via NCBI eutils / OpenAlex when network is available.
 *
 * @see docs/SCIENTIFIC-METHOD.md
 * @see js/scientific-method.js
 */

/** Loose DOI shape: 10.prefix/suffix — does not prove the DOI exists. */
export const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>\]]+)/gi;

/** PubMed ID shape. */
export const PMID_RE = /\bPMID[:\s]*(\d{1,8})\b/gi;

/**
 * Extract DOI-looking strings from text (shape only).
 * @param {string} text
 * @returns {string[]}
 */
export function extractDois(text) {
  const found = new Set();
  const src = String(text ?? "");
  for (const m of src.matchAll(DOI_RE)) {
    const doi = m[1].replace(/[.,;:)]+$/, "");
    if (/^10\.\d{4,9}\/\S+$/i.test(doi)) found.add(doi);
  }
  return [...found];
}

/**
 * Extract PMIDs from text (shape only).
 * @param {string} text
 * @returns {string[]}
 */
export function extractPmids(text) {
  const found = new Set();
  const src = String(text ?? "");
  for (const m of src.matchAll(PMID_RE)) {
    found.add(m[1]);
  }
  // bare numeric after "pubmed/" urls
  for (const m of src.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,8})/gi)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Identifiers that appear outside Observations without also appearing in Observations
 * are treated as unverified / potential fabrication risk.
 *
 * @param {string} bodyMarkdown
 * @param {(body: string, title: string) => string} extractSection
 * @param {(body: string, title: string) => boolean} headingPresent
 * @returns {{ ok: boolean, errors: string[], observationsDois: string[], observationsPmids: string[], leakedDois: string[], leakedPmids: string[] }}
 */
export function checkIdentifierProvenance(bodyMarkdown, extractSection, headingPresent) {
  const body = String(bodyMarkdown ?? "");
  const errors = [];
  let observations = "";
  if (headingPresent(body, "Observations (data in hand)")) {
    observations = extractSection(body, "Observations (data in hand)");
  }

  const observationsDois = extractDois(observations);
  const observationsPmids = extractPmids(observations);
  const allDois = extractDois(body);
  const allPmids = extractPmids(body);

  const obsDoiSet = new Set(observationsDois.map((d) => d.toLowerCase()));
  const obsPmidSet = new Set(observationsPmids);

  const leakedDois = allDois.filter((d) => !obsDoiSet.has(d.toLowerCase()));
  const leakedPmids = allPmids.filter((p) => !obsPmidSet.has(p));

  if (leakedDois.length) {
    errors.push(`unverified_doi_outside_observations:${leakedDois.join("|")}`);
  }
  if (leakedPmids.length) {
    errors.push(`unverified_pmid_outside_observations:${leakedPmids.join("|")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    observationsDois,
    observationsPmids,
    leakedDois,
    leakedPmids,
  };
}

/**
 * Shape-validate a DOI string without claiming it exists.
 * @param {string} doi
 */
export function isWellFormedDoi(doi) {
  const cleaned = String(doi ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return /^10\.\d{4,9}\/\S+$/i.test(cleaned);
}

/**
 * Shape-validate a PMID.
 * @param {string} pmid
 */
export function isWellFormedPmid(pmid) {
  return /^\d{1,8}$/.test(String(pmid ?? "").trim().replace(/^PMID[:\s]*/i, ""));
}

/**
 * Verify a PMID exists via NCBI eutils (official). Does not invent results.
 * @param {string} pmid
 * @param {{ fetchImpl?: typeof fetch, apiKey?: string }} [options]
 */
export async function verifyPubmedId(pmid, options = {}) {
  const cleaned = String(pmid ?? "").trim().replace(/^PMID[:\s]*/i, "");
  if (!isWellFormedPmid(cleaned)) {
    return { ok: false, status: "error", message: "malformed_pmid", pmid: cleaned };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, status: "unavailable", message: "fetch_unavailable", pmid: cleaned };
  }
  const params = new URLSearchParams({ db: "pubmed", id: cleaned, retmode: "json" });
  if (options.apiKey) params.set("api_key", options.apiKey);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    return { ok: false, status: "error", message: `http_${res.status}`, pmid: cleaned };
  }
  const data = await res.json();
  const row = data?.result?.[cleaned];
  if (!row?.title) {
    return { ok: false, status: "not_found", message: "pmid_not_found", pmid: cleaned };
  }
  const retracted =
    /retract/i.test(String(row.title)) ||
    JSON.stringify(row).includes("Retracted Publication");
  return {
    ok: true,
    status: retracted ? "retracted" : "ok",
    pmid: cleaned,
    title: row.title,
    retracted,
    url: `https://pubmed.ncbi.nlm.nih.gov/${cleaned}/`,
  };
}

/**
 * Verify a DOI via OpenAlex (official). Does not invent results.
 * Set OPENALEX_MAILTO / FLUX_SCIENCE_OPENALEX_MAILTO for the polite pool.
 * @param {string} doi
 * @param {{ fetchImpl?: typeof fetch, mailto?: string }} [options]
 */
export async function verifyOpenAlexDoi(doi, options = {}) {
  const cleaned = String(doi ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  if (!isWellFormedDoi(cleaned)) {
    return { ok: false, status: "error", message: "malformed_doi", doi: cleaned };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, status: "unavailable", message: "fetch_unavailable", doi: cleaned };
  }
  const mailto =
    options.mailto ||
    process.env.OPENALEX_MAILTO ||
    process.env.FLUX_SCIENCE_OPENALEX_MAILTO ||
    "";
  const url = new URL(`https://api.openalex.org/works/https://doi.org/${cleaned}`);
  if (mailto) url.searchParams.set("mailto", mailto);
  const res = await fetchImpl(url);
  if (res.status === 404) {
    return { ok: false, status: "not_found", message: "doi_not_found", doi: cleaned };
  }
  if (res.status === 429 || res.status === 403) {
    return {
      ok: false,
      status: "unavailable",
      message: "openalex_rate_limited",
      doi: cleaned,
    };
  }
  if (!res.ok) {
    return { ok: false, status: "error", message: `http_${res.status}`, doi: cleaned };
  }
  const data = await res.json();
  return {
    ok: true,
    status: data?.is_retracted ? "retracted" : "ok",
    doi: cleaned,
    title: data?.display_name ?? null,
    retracted: Boolean(data?.is_retracted),
    url: data?.doi ?? `https://doi.org/${cleaned}`,
    openalexId: data?.id ?? null,
  };
}

/**
 * Verify PubChem compound name → CID/formula (official PUG REST).
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function verifyPubchemName(name, options = {}) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return { ok: false, status: "error", message: "empty_name" };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, status: "unavailable", message: "fetch_unavailable" };
  }
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(trimmed)}/property/MolecularFormula,MolecularWeight/JSON`;
  const res = await fetchImpl(url);
  if (res.status === 404) {
    return { ok: false, status: "not_found", message: "compound_not_found", name: trimmed };
  }
  if (!res.ok) {
    return { ok: false, status: "error", message: `http_${res.status}`, name: trimmed };
  }
  const data = await res.json();
  const props = data?.PropertyTable?.Properties?.[0];
  if (!props?.CID || !props.MolecularFormula) {
    return { ok: false, status: "not_found", message: "incomplete_payload", name: trimmed };
  }
  return {
    ok: true,
    status: "ok",
    name: trimmed,
    cid: Number(props.CID),
    formula: String(props.MolecularFormula),
    molecularWeight: String(props.MolecularWeight),
    url: `https://pubchem.ncbi.nlm.nih.gov/compound/${props.CID}`,
  };
}
