#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupAppliedByDesk, renderAppendixMarkdown } from "../js/evolution.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export async function materializeEvolution(applied, root = ROOT) {
  const list = Array.isArray(applied) ? applied : [];
  const fluxDir = join(root, ".flux", "evolution");
  await mkdir(fluxDir, { recursive: true });
  await writeFile(join(fluxDir, "applied.json"), `${JSON.stringify(list, null, 2)}\n`, "utf8");

  const byDesk = groupAppliedByDesk(list);
  const appendices = {};
  for (const [deskId, patches] of Object.entries(byDesk)) {
    const appendix = renderAppendixMarkdown(patches);
    const agentPath = join(root, "agents", deskId, "bot", "evolution-appendix.md");
    await mkdir(join(root, "agents", deskId, "bot"), { recursive: true });
    await writeFile(agentPath, appendix, "utf8");
    appendices[deskId] = agentPath;
    await writeFile(join(fluxDir, `${deskId}.md`), `${appendix}\n`, "utf8");
  }

  return {
    appliedCount: list.length,
    appendices,
    fluxApplied: join(fluxDir, "applied.json"),
  };
}

if (process.argv[1]?.endsWith("materialize-evolution.mjs")) {
  const raw = process.argv[2];
  const applied = raw ? JSON.parse(raw) : [];
  materializeEvolution(applied).then((out) => {
    console.log(JSON.stringify({ ok: true, ...out }, null, 2));
  });
}
