/** Orchestrator-linked websites for 24/7 ingestion toward in-silico trial research. */

export const LINKED_SOURCES_VERSION = 1;

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

function isBlockedIpv4Literal(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split(".").map(Number);
  if (parts.some((n) => Number.isNaN(n) || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** Reject localhost, private IP literals, and metadata-style hosts (browser-safe). */
export function isUnsafeLinkedHostname(hostname) {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  if (isBlockedIpv4Literal(host)) return true;
  return false;
}

export function normalizeUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (isUnsafeLinkedHostname(url.hostname)) return null;
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

export function sanitizeLinkedSource(raw) {
  const normalized = normalizeUrl(raw?.url);
  if (!normalized) return null;
  const label = String(raw?.label ?? "").trim() || hostnameOf(normalized);
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map((t) => String(t).trim()).filter(Boolean)
    : ["insilico"];
  const id =
    typeof raw?.id === "string" && /^src_[\w.-]+$/.test(raw.id)
      ? raw.id
      : `src_${hostnameOf(normalized).replace(/\W+/g, "_")}_${Date.now().toString(36)}`;
  const addedAt = Number.isFinite(raw?.addedAt) ? raw.addedAt : Date.now();
  return {
    id,
    url: normalized,
    label,
    tags: tags.length ? tags : ["insilico"],
    addedAt,
  };
}

export function mergeSourcesConfig(existing, sources) {
  const base = existing?.version === LINKED_SOURCES_VERSION ? existing : emptyLinkedSourcesConfig();
  const list = Array.isArray(sources) ? sources : base.sources;
  return {
    version: LINKED_SOURCES_VERSION,
    sources: list.map(sanitizeLinkedSource).filter(Boolean),
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
