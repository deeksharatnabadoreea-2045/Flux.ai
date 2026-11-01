import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Floor files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Floor. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_floor_report");
  },
});
