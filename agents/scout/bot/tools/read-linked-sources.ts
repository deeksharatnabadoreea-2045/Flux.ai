import { defineTool } from "@grok/agent-sdk/tools";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import { fluxRepoRoot } from "../lib/repo-root.ts";

export default defineTool({
  description:
    "List orchestrator-linked websites and the latest sync manifest (24/7 source watch).",
  effect: "read",
  inputSchema: z.object({}),
  async execute() {
    const root = fluxRepoRoot();
    const configPath = join(root, "config/linked-sources.json");
    const manifestPath = join(root, ".flux/source-snapshots/manifest.json");
    let config = { version: 1, sources: [] as unknown[] };
    let manifest = null;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      /* empty */
    }
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      /* not synced yet */
    }
    return { config, manifest, repoRoot: root };
  },
});
