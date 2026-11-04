import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIngestSources, parseTrustedSourcesConfig } from "./trusted-sources.js";

test("trusted catalog parses with tiers", () => {
  const cfg = parseTrustedSourcesConfig({
    version: 1,
    sources: [{ id: "t1", url: "https://clinicaltrials.gov/", label: "CT", trustTier: "registry" }],
  });
  assert.equal(cfg.sources.length, 1);
  assert.equal(cfg.sources[0].trustTier, "registry");
});

test("mergeIngestSources dedupes orchestrator link already in trusted", () => {
  const trusted = [{ id: "t1", url: "https://clinicaltrials.gov/", label: "CT", trustTier: "registry" }];
  const linked = [
    {
      id: "src_user",
      url: "https://clinicaltrials.gov/",
      label: "User CT",
      tags: ["insilico"],
    },
  ];
  const merged = mergeIngestSources(linked, trusted);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, "trusted");
});
