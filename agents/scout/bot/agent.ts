import { defineAgent } from "@grok/agent-sdk";
import { fluxRepoRoot } from "./lib/repo-root.ts";

export default defineAgent({
  local: {
    cwd: fluxRepoRoot(),
  },
  hosting: {
    /** Linked sources — see config/linked-sources.json and docs/LINKED-SOURCES.md */
    egressDomains: ["clinicaltrials.gov"],
  },
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
