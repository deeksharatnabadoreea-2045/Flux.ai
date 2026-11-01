#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupAppliedByAgent, renderAppendixMarkdown } from "../js/evolution.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export async function materializeEvolution(applied, root = ROOT) {
  const list = Array.isArray(applied) ? applied : [];
  const fluxDir = join(root, ".flux", "evolution");
  await mkdir(fluxDir, { recursive: true });
  await writeFile(join(fluxDir, "applied.json"), `${JSON.stringify(list, null, 2)}\n`, "utf8");

  const { scout } = groupAppliedByAgent(list);
  const appendix = renderAppendixMarkdown(scout);
  const scoutPath = join(root, "agents", "scout", "bot", "evolution-appendix.md");
  await mkdir(join(root, "agents", "scout", "bot"), { recursive: true });
  await writeFile(scoutPath, appendix, "utf8");

  return {
    appliedCount: list.length,
    scoutAppendix: scoutPath,
    fluxApplied: join(fluxDir, "applied.json"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.argv[2];
  const applied = raw ? JSON.parse(raw) : [];
  materializeEvolution(applied).then((out) => {
    console.log(JSON.stringify({ ok: true, ...out }, null, 2));
  });
}
