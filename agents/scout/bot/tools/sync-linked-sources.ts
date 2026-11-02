import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fluxRepoRoot } from "../lib/repo-root.ts";

export default defineTool({
  description:
    "Fetch all orchestrator-linked websites and refresh local snapshots for Scout analysis.",
  effect: "write",
  execution: "server",
  inputSchema: z.object({}),
  async execute() {
    const root = fluxRepoRoot();
    const mod = await import(pathToFileURL(join(root, "js/linked-sources-sync.mjs")).href);
    const manifest = await mod.syncLinkedSources(root);
    return { synced: true, manifest };
  },
});
