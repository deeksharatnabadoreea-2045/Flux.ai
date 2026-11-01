import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Voice files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for Voice. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_voice_report");
  },
});
