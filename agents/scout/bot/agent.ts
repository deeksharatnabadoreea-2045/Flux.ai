import { defineAgent } from "@grok/agent-sdk";
import { fluxRepoRoot } from "./lib/repo-root.ts";

export default defineAgent({
  local: {
    cwd: fluxRepoRoot(),
  },
  hosting: {
    /** Linked sources — see config/linked-sources.json and docs/LINKED-SOURCES.md */
    egressDomains: ["clinicaltrials.gov", "ncbi.nlm.nih.gov", "fda.gov", "www.fda.gov", "who.int", "trialsearch.who.int"],
  },
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
