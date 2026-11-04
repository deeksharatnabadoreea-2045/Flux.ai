/**
 * Live feed from PubMed, UniProt, and AlphaFold DB (server-side fetch).
 */

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UNIPROT_SEARCH = "https://rest.uniprot.org/uniprotkb/search";
const PUBMED_TOPIC_ROTATION = [
  "biomarker OR clinical trial",
  "CRISPR OR gene therapy",
  "protein structure OR AlphaFold",
  "drug target OR pharmacology",
  "single-cell OR transcriptomics",
  "immunotherapy OR oncology",
  "neurodegeneration OR Alzheimer",
];

const DEFAULT_QUERIES = {
  pubmed: process.env.FLUX_PUBMED_QUERY ?? "biomarker OR CRISPR OR protein structure prediction",
  uniprot: process.env.FLUX_UNIPROT_QUERY ?? "(organism_id:9606) AND reviewed:true",
};

function formatPubMedDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

export function pubmedRecentQuery(baseQuery, days = 14, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Math.max(1, days));
  return `(${baseQuery}) AND (${formatPubMedDate(start)}:${formatPubMedDate(end)}[dp])`;
}

export function queriesForDay(date = new Date()) {
  const topic = PUBMED_TOPIC_ROTATION[date.getUTCDay() % PUBMED_TOPIC_ROTATION.length];
  return {
    pubmed: topic,
    uniprot: DEFAULT_QUERIES.uniprot,
  };
}

const USER_AGENT =
  process.env.FLUX_EUTILS_TOOL ??
  "FluxCoScientist/1.0 (https://github.com/deeksharatnabadoreea-2045/Flux.ai; mailto:support@flux.ai)";

export function normalizeFeedItem(item) {
  return {
    id: String(item.id),
    source: item.source,
    title: String(item.title ?? "").trim(),
    summary: String(item.summary ?? "").trim(),
    url: String(item.url ?? ""),
    publishedAt: item.publishedAt ?? null,
    meta: item.meta ?? {},
  };
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`fetch_failed:${res.status}:${url}`);
  return res.json();
}

export async function fetchPubMedItems({ query = DEFAULT_QUERIES.pubmed, limit = 5 } = {}) {
  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(limit),
    sort: "date",
    retmode: "json",
  });
  const search = await fetchJson(`${PUBMED_BASE}/esearch.fcgi?${searchParams}`);
  const ids = search?.esearchresult?.idlist ?? [];
  if (!ids.length) return [];

  const summaryParams = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
  });
  const summary = await fetchJson(`${PUBMED_BASE}/esummary.fcgi?${summaryParams}`);
  const result = summary?.result ?? {};

  return ids.map((id) => {
    const row = result[id] ?? {};
    const title = row.title ?? `PubMed ${id}`;
    const pubdate = row.pubdate ?? row.epubdate ?? null;
    return normalizeFeedItem({
      id: `pubmed-${id}`,
      source: "pubmed",
      title,
      summary: row.sortfirstauthor
        ? `${row.source ?? "Journal"} · ${row.sortfirstauthor}${row.authors?.length > 1 ? " et al." : ""}`
        : "Peer-reviewed literature",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      publishedAt: pubdate,
      meta: { pmid: id, journal: row.source ?? null },
    });
  });
}

export async function fetchUniProtItems({ query = DEFAULT_QUERIES.uniprot, limit = 5 } = {}) {
  const params = new URLSearchParams({
    query,
    size: String(limit),
  });
  const data = await fetchJson(`${UNIPROT_SEARCH}?${params}`);
  const rows = data?.results ?? [];

  return rows.map((row) => {
    const accession = row.primaryAccession ?? row.uniProtkbId ?? "unknown";
    const proteinName =
      row.proteinDescription?.recommendedName?.fullName?.value ??
      row.proteinDescription?.submissionNames?.[0]?.fullName?.value ??
      accession;
    return normalizeFeedItem({
      id: `uniprot-${accession}`,
      source: "uniprot",
      title: proteinName,
      summary: `${row.organism?.scientificName ?? "Organism"} · UniProt ${accession}`,
      url: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
      publishedAt: row.entryAudit?.lastAnnotationUpdateDate ?? null,
      meta: { accession },
    });
  });
}

export async function fetchAlphaFoldItems({ accessions = [], limit = 5 } = {}) {
  const ids = [...new Set(accessions.filter(Boolean))].slice(0, limit);
  if (!ids.length) {
    ids.push("P00533", "P04637", "P01308");
  }

  const settled = await Promise.allSettled(
    ids.map((accession) =>
      fetchJson(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(accession)}`),
    ),
  );

  const items = [];
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const rows = result.value;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return;
    const uniprotAccession = row.uniprotAccession ?? ids[index];
    const entryId = row.modelEntityId ?? `AF-${uniprotAccession}`;
    items.push(
      normalizeFeedItem({
        id: `alphafold-${entryId}`,
        source: "alphafold",
        title: row.gene ?? row.uniprotDescription ?? `Structure ${uniprotAccession}`,
        summary: `${row.toolUsed ?? "AlphaFold"} · ${entryId}`,
        url: `https://alphafold.ebi.ac.uk/entry/${uniprotAccession}`,
        publishedAt: row.modelCreatedDate ?? null,
        meta: { entryId, uniprotAccession },
      }),
    );
  });
  return items;
}

export async function buildCoScientistFeed(options = {}) {
  const limit = options.limit ?? 4;
  const queryBundle = { ...DEFAULT_QUERIES, ...(options.queries ?? {}) };
  const pubmedQuery =
    options.pubmedRecentDays != null
      ? pubmedRecentQuery(queryBundle.pubmed, options.pubmedRecentDays)
      : queryBundle.pubmed;
  const errors = [];
  const buckets = { pubmed: [], uniprot: [], alphafold: [] };

  const pubmedResult = await Promise.allSettled([
    fetchPubMedItems({ query: pubmedQuery, limit }),
  ]);
  if (pubmedResult[0].status === "fulfilled") buckets.pubmed = pubmedResult[0].value;
  else errors.push({ source: "pubmed", error: pubmedResult[0].reason?.message ?? "unknown" });

  const uniprotResult = await Promise.allSettled([
    fetchUniProtItems({ query: queryBundle.uniprot, limit: Math.min(3, limit) }),
  ]);
  if (uniprotResult[0].status === "fulfilled") buckets.uniprot = uniprotResult[0].value;
  else errors.push({ source: "uniprot", error: uniprotResult[0].reason?.message ?? "unknown" });

  const accessions = buckets.uniprot.map((item) => item.meta?.accession).filter(Boolean);
  const afResult = await Promise.allSettled([
    fetchAlphaFoldItems({ accessions, limit: Math.min(3, limit) }),
  ]);
  if (afResult[0].status === "fulfilled") buckets.alphafold = afResult[0].value;
  else errors.push({ source: "alphafold", error: afResult[0].reason?.message ?? "unknown" });

  const interleaved = [];
  const maxLen = Math.max(buckets.pubmed.length, buckets.uniprot.length, buckets.alphafold.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (buckets.pubmed[i]) interleaved.push(buckets.pubmed[i]);
    if (buckets.uniprot[i]) interleaved.push(buckets.uniprot[i]);
    if (buckets.alphafold[i]) interleaved.push(buckets.alphafold[i]);
  }

  return {
    fetchedAt: new Date().toISOString(),
    items: interleaved,
    errors,
    queries: { ...queryBundle, pubmedResolved: pubmedQuery },
  };
}
