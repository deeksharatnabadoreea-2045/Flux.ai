import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildCoScientistFeed, queriesForDay } from "./co-scientist-feed.mjs";

export const DAILY_SYNC_MS = Number(process.env.FLUX_DAILY_SYNC_MS ?? 24 * 60 * 60 * 1000);
export const ARCHIVE_MAX_ITEMS = Number(process.env.FLUX_ARCHIVE_MAX_ITEMS ?? 400);

export function emptyArchive() {
  return {
    version: 1,
    lastDailySyncAt: null,
    items: [],
  };
}

export function normalizeArchive(raw) {
  if (!raw || typeof raw !== "object") return emptyArchive();
  return {
    version: 1,
    lastDailySyncAt: raw.lastDailySyncAt ?? null,
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export function mergeArchiveItems(existingItems, incomingItems, nowIso) {
  const byId = new Map();
  for (const item of existingItems) {
    if (item?.id) byId.set(item.id, { ...item });
  }
  let added = 0;
  for (const item of incomingItems) {
    if (!item?.id) continue;
    const prev = byId.get(item.id);
    if (prev) {
      byId.set(item.id, { ...prev, ...item, lastSeenAt: nowIso });
    } else {
      added += 1;
      byId.set(item.id, { ...item, firstSeenAt: nowIso, lastSeenAt: nowIso });
    }
  }
  const items = [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.firstSeenAt ?? a.lastSeenAt ?? 0);
    const tb = Date.parse(b.firstSeenAt ?? b.lastSeenAt ?? 0);
    return tb - ta;
  });
  return { items: items.slice(0, ARCHIVE_MAX_ITEMS), added };
}

export function archiveNeedsDailySync(archive, nowMs = Date.now()) {
  if (!archive.lastDailySyncAt) return true;
  const last = Date.parse(archive.lastDailySyncAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= DAILY_SYNC_MS;
}

export function archiveToFeedPayload(archive, meta = {}) {
  return {
    fetchedAt: archive.lastDailySyncAt ?? new Date().toISOString(),
    items: archive.items,
    errors: meta.errors ?? [],
    queries: meta.queries ?? {},
    archiveSize: archive.items.length,
    dailySync: true,
  };
}

function archivePath(root) {
  return join(root, ".flux/co-scientist-archive.json");
}

export async function readFileArchive(root) {
  try {
    const raw = await readFile(archivePath(root), "utf8");
    return normalizeArchive(JSON.parse(raw));
  } catch {
    return emptyArchive();
  }
}

export async function writeFileArchive(root, archive) {
  await mkdir(join(root, ".flux"), { recursive: true });
  await writeFile(archivePath(root), JSON.stringify(normalizeArchive(archive), null, 2));
}

/**
 * Pull fresh PubMed / UniProt / AlphaFold rows and merge into the archive.
 */
export async function runDailyCoScientistSync({ loadArchive, saveArchive, force = false } = {}) {
  if (!loadArchive || !saveArchive) {
    throw new Error("archive_store_required");
  }
  const archive = normalizeArchive(await loadArchive());
  const now = new Date();
  const nowIso = now.toISOString();

  if (!force && !archiveNeedsDailySync(archive, now.getTime())) {
    return { archive, added: 0, skipped: true };
  }

  const queries = queriesForDay(now);
  const batch = await buildCoScientistFeed({
    limit: 8,
    queries,
    pubmedRecentDays: 14,
  });

  const { items, added } = mergeArchiveItems(archive.items, batch.items, nowIso);
  const next = {
    version: 1,
    lastDailySyncAt: nowIso,
    items,
  };
  await saveArchive(next);

  return {
    archive: next,
    added,
    skipped: false,
    errors: batch.errors,
    queries: batch.queries,
  };
}

export async function runDailyCoScientistSyncFile(root, options = {}) {
  return runDailyCoScientistSync({
    force: options.force,
    loadArchive: () => readFileArchive(root),
    saveArchive: (archive) => writeFileArchive(root, archive),
  });
}
