import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  archiveToFeedPayload,
  normalizeArchive,
  runDailyCoScientistSync,
  runDailyCoScientistSyncFile,
} from "./co-scientist-archive.mjs";
import {
  getNetlifyBlobStore,
  loadBlobArchive,
  saveBlobArchive,
} from "./co-scientist-blob-store.mjs";
import { buildCoScientistReply } from "./co-scientist-chat.mjs";
import {
  emptyFeedbackState,
  normalizeFeedbackState,
  recordFeedback,
  profileFromFeedback,
} from "./co-scientist-feedback.mjs";

const FEED_CACHE_MS = Number(process.env.FLUX_FEED_CACHE_MS ?? 15 * 60 * 1000);
let feedCache = { at: 0, payload: null };

function feedbackPath(root) {
  return join(root, ".flux/co-scientist-feedback.json");
}

export async function readFeedbackState(root) {
  try {
    const raw = await readFile(feedbackPath(root), "utf8");
    return normalizeFeedbackState(JSON.parse(raw));
  } catch {
    return emptyFeedbackState();
  }
}

export async function writeFeedbackState(root, state) {
  await mkdir(join(root, ".flux"), { recursive: true });
  await writeFile(feedbackPath(root), JSON.stringify(normalizeFeedbackState(state), null, 2));
}

async function syncArchiveStores(root, { force = false } = {}) {
  const blobStore = await getNetlifyBlobStore();
  if (blobStore) {
    return runDailyCoScientistSync({
      force,
      loadArchive: async () => normalizeArchive(await loadBlobArchive(blobStore)),
      saveArchive: (archive) => saveBlobArchive(blobStore, archive),
    });
  }
  return runDailyCoScientistSyncFile(root, { force });
}

export async function getCoScientistFeed(root, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && feedCache.payload && now - feedCache.at < FEED_CACHE_MS) {
    return { ...feedCache.payload, cached: true };
  }
  const sync = await syncArchiveStores(root, { force: refresh });
  const payload = {
    ...archiveToFeedPayload(sync.archive, {
      errors: sync.errors ?? [],
      queries: sync.queries ?? {},
    }),
    addedToday: sync.added ?? 0,
    skipped: sync.skipped ?? false,
  };
  feedCache = { at: now, payload };
  return { ...payload, cached: false };
}

export async function forceDailyCoScientistSync(root) {
  feedCache = { at: 0, payload: null };
  return syncArchiveStores(root, { force: true });
}

export async function postCoScientistChat(root, { message, feed }) {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("message_required");
  const feedbackState = await readFeedbackState(root);
  const profile = profileFromFeedback(feedbackState);
  let activeFeed = feed;
  if (!activeFeed?.items?.length) {
    activeFeed = await getCoScientistFeed(root);
  }
  const reply = buildCoScientistReply({
    message: text,
    feed: activeFeed,
    feedbackProfile: profile,
  });
  return {
    ok: true,
    reply,
    feedFetchedAt: activeFeed.fetchedAt,
    feedbackProfile: profile,
  };
}

export async function postCoScientistFeedback(root, { messageId, rating, intents }) {
  const state = recordFeedback(await readFeedbackState(root), {
    messageId,
    rating,
    intents,
  });
  await writeFeedbackState(root, state);
  return { ok: true, profile: profileFromFeedback(state) };
}
