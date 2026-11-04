import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeArchiveItems,
  archiveNeedsDailySync,
  emptyArchive,
} from "./co-scientist-archive.mjs";

test("mergeArchiveItems adds new ids and preserves firstSeenAt", () => {
  const now = "2026-11-05T00:00:00.000Z";
  const { items, added } = mergeArchiveItems(
    [{ id: "a", title: "Old", source: "pubmed" }],
    [
      { id: "a", title: "Old updated", source: "pubmed" },
      { id: "b", title: "New", source: "uniprot" },
    ],
    now,
  );
  assert.equal(added, 1);
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.id === "b")?.firstSeenAt, now);
});

test("archiveNeedsDailySync after 24h", () => {
  const archive = {
    ...emptyArchive(),
    lastDailySyncAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  };
  assert.equal(archiveNeedsDailySync(archive), true);
});
