import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Maker files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Maker. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_maker_report");
  },
});
