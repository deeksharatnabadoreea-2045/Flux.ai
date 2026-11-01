import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Wire files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Wire. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_wire_report");
  },
});
