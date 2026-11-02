/** Orchestrator-linked websites for 24/7 ingestion toward in-silico trial research. */

export const LINKED_SOURCES_VERSION = 1;

export function normalizeUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function emptyLinkedSourcesConfig() {
  return { version: LINKED_SOURCES_VERSION, sources: [] };
}

export function validateSourceInput({ url, label, tags }) {
  const normalized = normalizeUrl(url);
  if (!normalized) return { ok: false, error: "invalid_url" };
  const name = String(label ?? "").trim() || hostnameOf(normalized);
  const tagList = Array.isArray(tags)
    ? tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  return {
    ok: true,
    source: {
      id: `src_${hostnameOf(normalized).replace(/\W+/g, "_")}_${Date.now().toString(36)}`,
      url: normalized,
      label: name,
      tags: tagList.length ? tagList : ["insilico"],
      addedAt: Date.now(),
    },
  };
}

export function mergeSourcesConfig(existing, sources) {
  const base = existing?.version === LINKED_SOURCES_VERSION ? existing : emptyLinkedSourcesConfig();
  return {
    version: LINKED_SOURCES_VERSION,
    sources: Array.isArray(sources) ? sources : base.sources,
  };
}

export function egressDomainsFromConfig(config) {
  const hosts = new Set();
  for (const s of config?.sources ?? []) {
    const h = hostnameOf(s.url);
    if (h) hosts.add(h);
  }
  return [...hosts].sort();
}
