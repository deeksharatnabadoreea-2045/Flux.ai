import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Ledger files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Ledger. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_ledger_report");
  },
});
