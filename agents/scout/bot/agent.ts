import { defineAgent } from "@grok/agent-sdk";
import { fluxRepoRoot } from "./lib/repo-root.ts";

export default defineAgent({
  local: {
    cwd: fluxRepoRoot(),
  },
  hosting: {
    /** Add each linked hostname before deploy — see docs/LINKED-SOURCES.md */
    egressDomains: [],
  },
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
