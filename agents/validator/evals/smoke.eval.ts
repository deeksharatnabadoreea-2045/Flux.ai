import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Validator files work for the orchestrator.",
  async test(t) {
    await t.send(
      "Brief: Scientific-method smoke audit — hypothesis testable, no fake science. Company: Flux.ai. File full Validator sections and attestation.",
    );
    t.succeeded();
    t.calledTool("file_validator_report");
  },
});
