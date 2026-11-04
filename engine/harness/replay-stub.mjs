#!/usr/bin/env node
/**
 * L1 harness placeholder — proves factory wiring (snapshots → structured replay packet).
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(ROOT, ".flux/source-snapshots/manifest.json");

async function main() {
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    manifest = { syncedAt: null, count: 0, results: [] };
  }

  const registryHits = (manifest.results ?? []).filter(
    (r) => r.ok && String(r.url ?? "").includes("clinicaltrials.gov"),
  );

  const packet = {
    kind: "flux.replay-packet.v0",
    generatedAt: new Date().toISOString(),
    validationStage: "L0-mechanistic",
    note: "Stub only — no concordance computed. Implement L1 in Maker before any go/no-go claim.",
    ingest: {
      syncedAt: manifest.syncedAt ?? null,
      sourceCount: manifest.count ?? 0,
      registrySnapshots: registryHits.length,
    },
    nextImplementation: [
      "Parse ClinicalTrials API v2 JSON snapshots into digital-cohort.v0.json instances",
      "Register primary endpoints per NCT id from registry metadata",
      "Compare emulated vs published results with pre-registered rules (L1)",
    ],
  };

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
