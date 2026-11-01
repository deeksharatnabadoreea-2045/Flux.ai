import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Forge files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Forge. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_forge_report");
  },
});
