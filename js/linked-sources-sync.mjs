/**
 * Fetch linked sources and write snapshots for 24/7 agents (Node only).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { emptyLinkedSourcesConfig, mergeSourcesConfig } from "./linked-sources.js";
import { mergeIngestSources, parseTrustedSourcesConfig } from "./trusted-sources.js";

const MAX_BYTES = 512_000;
const EXCERPT_CHARS = 24_000;

export function repoPaths(repoRoot) {
  const configPath = join(repoRoot, "config/linked-sources.json");
  const trustedPath = join(repoRoot, "config/trusted-sources.json");
  const snapDir = join(repoRoot, ".flux/source-snapshots");
  const manifestPath = join(snapDir, "manifest.json");
  const factoryDir = join(repoRoot, ".flux/factory");
  const ingestLogPath = join(factoryDir, "ingest-log.jsonl");
  return { configPath, trustedPath, snapDir, manifestPath, factoryDir, ingestLogPath };
}

export async function readTrustedSourcesConfig(repoRoot) {
  const { trustedPath } = repoPaths(repoRoot);
  try {
    const raw = await readFile(trustedPath, "utf8");
    return parseTrustedSourcesConfig(JSON.parse(raw));
  } catch {
    return parseTrustedSourcesConfig(null);
  }
}

export async function readIngestSources(repoRoot) {
  const linked = await readLinkedSourcesConfig(repoRoot);
  const trusted = await readTrustedSourcesConfig(repoRoot);
  return mergeIngestSources(linked.sources, trusted.sources);
}

export async function readLinkedSourcesConfig(repoRoot) {
  const { configPath } = repoPaths(repoRoot);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return mergeSourcesConfig(parsed, parsed.sources);
  } catch {
    return emptyLinkedSourcesConfig();
  }
}

export async function writeLinkedSourcesConfig(repoRoot, config) {
  const { configPath } = repoPaths(repoRoot);
  await mkdir(join(repoRoot, "config"), { recursive: true });
  const body = mergeSourcesConfig(config, config.sources);
  await writeFile(configPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromHtml(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 200) : "";
}

export async function fetchOneSource(source, { signal } = {}) {
  const res = await fetch(source.url, {
    signal,
    headers: {
      "user-agent": "Flux.ai-SourceWatch/1.0 (+in-silico research)",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const clipped = buf.subarray(0, MAX_BYTES);
  const contentType = res.headers.get("content-type") ?? "";
  const raw = clipped.toString("utf8");
  const isHtml = contentType.includes("html") || raw.includes("<html");
  const text = isHtml ? stripHtml(raw) : raw;
  return {
    id: source.id,
    url: source.url,
    label: source.label,
    fetchedAt: new Date().toISOString(),
    status: res.status,
    ok: res.ok,
    contentType,
    title: isHtml ? titleFromHtml(raw) : "",
    excerpt: text.slice(0, EXCERPT_CHARS),
    byteLength: buf.length,
  };
}

export async function syncLinkedSources(repoRoot, { perSourceMs = 45_000 } = {}) {
  const { snapDir, manifestPath, factoryDir, ingestLogPath } = repoPaths(repoRoot);
  const linked = await readLinkedSourcesConfig(repoRoot);
  const trusted = await readTrustedSourcesConfig(repoRoot);
  const sources = mergeIngestSources(linked.sources, trusted.sources);
  await mkdir(snapDir, { recursive: true });
  await mkdir(factoryDir, { recursive: true });

  const results = await Promise.all(
    sources.map(async (source) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perSourceMs);
      try {
        const snap = await fetchOneSource(source, { signal: controller.signal });
        const fileName = `${source.id}.json`;
        await writeFile(join(snapDir, fileName), `${JSON.stringify(snap, null, 2)}\n`, "utf8");
        return {
          ...snap,
          file: fileName,
          error: null,
          origin: source.origin ?? "linked",
          trustTier: source.trustTier,
        };
      } catch (error) {
        return {
          id: source.id,
          url: source.url,
          label: source.label,
          origin: source.origin ?? "linked",
          trustTier: source.trustTier,
          fetchedAt: new Date().toISOString(),
          ok: false,
          error: error instanceof Error ? error.message : "fetch_failed",
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const manifest = {
    syncedAt: new Date().toISOString(),
    factoryPolicy: trusted.policy || "ingest-only",
    count: sources.length,
    trustedCount: trusted.sources.length,
    linkedCount: linked.sources.length,
    results,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    ingestLogPath,
    `${JSON.stringify({ at: manifest.syncedAt, ok: results.filter((r) => r.ok).length, total: results.length })}\n`,
    { flag: "a" },
  );
  return manifest;
}
