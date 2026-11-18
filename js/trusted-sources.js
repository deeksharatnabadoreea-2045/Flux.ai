/** Curated trusted sources for 24/7 factory ingest (committed; not orchestrator-editable in HQ). */

import { hostnameOf, normalizeUrl } from "./linked-sources.js";

export const TRUSTED_SOURCES_VERSION = 1;

export function emptyTrustedSourcesConfig() {
  return { version: TRUSTED_SOURCES_VERSION, policy: "", sources: [] };
}

export function normalizeTrustedSource(raw) {
  const url = normalizeUrl(raw?.url);
  if (!url) return null;
  return {
    id: String(raw.id ?? `trust_${hostnameOf(url).replace(/\W+/g, "_")}`),
    url,
    label: String(raw.label ?? hostnameOf(url)),
    trustTier: String(raw.trustTier ?? "reference"),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : ["insilico"],
    origin: "trusted",
  };
}

export function parseTrustedSourcesConfig(parsed) {
  const base =
    parsed?.version === TRUSTED_SOURCES_VERSION ? parsed : emptyTrustedSourcesConfig();
  const sources = (Array.isArray(parsed?.sources) ? parsed.sources : [])
    .map(normalizeTrustedSource)
    .filter(Boolean);
  return {
    version: TRUSTED_SOURCES_VERSION,
    policy: String(parsed?.policy ?? base.policy ?? ""),
    sources,
  };
}

/** Orchestrator-linked sources plus trusted catalog, deduped by URL. */
export function mergeIngestSources(linkedSources = [], trustedSources = []) {
  const byUrl = new Map();
  for (const source of trustedSources) {
    const normalized = normalizeTrustedSource(source);
    if (normalized) byUrl.set(normalized.url, normalized);
  }
  for (const source of linkedSources) {
    const url = normalizeUrl(source.url);
    if (!url) continue;
    if (byUrl.has(url)) continue;
    byUrl.set(url, {
      id: source.id,
      url,
      label: source.label ?? hostnameOf(url),
      trustTier: "orchestrator",
      tags: source.tags ?? ["insilico"],
      origin: "linked",
    });
  }
  return [...byUrl.values()];
}

export function egressDomainsFromSources(sources) {
  const hosts = new Set();
  for (const s of sources ?? []) {
    const h = hostnameOf(s.url);
    if (h) hosts.add(h);
  }
  return [...hosts].sort();
}
