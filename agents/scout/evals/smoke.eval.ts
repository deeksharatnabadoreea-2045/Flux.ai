import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Scout files a research report with file_scout_report.",
  async test(t) {
    await t.send(
      'Brief: Is there demand for a "company of one" where the founder orchestrates AI desks? Company: Flux.ai. Mission: A company of one. The founder orchestrates. Agents do the manual jobs.',
    );
    t.succeeded();
    t.calledTool("file_scout_report");
  },
});
