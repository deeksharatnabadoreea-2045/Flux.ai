import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Validator files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Validator. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_validator_report");
  },
});
