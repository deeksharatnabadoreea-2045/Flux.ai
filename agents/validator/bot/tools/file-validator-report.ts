import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const Verdict = z.enum(["ship", "fix", "block"]);
const Recommendation = z.enum(["go", "wait", "ignore"]);

export default defineTool({
  description:
    "File the Validator audit for orchestrator review (science + platform code).",
  effect: "write",
  inputSchema: z.object({
    title: z.string().min(8).max(120),
    bodyMarkdown: z.string().min(200),
    verdict: Verdict,
    recommendation: Recommendation,
  }),
  async execute({ title, bodyMarkdown, verdict, recommendation }, ctx) {
    const key = `validator:${ctx.session.id}:latest`;
    await ctx.host.kv.put(key, {
      title,
      bodyMarkdown,
      verdict,
      recommendation,
      filedAt: new Date().toISOString(),
      sessionId: ctx.session.id,
    });
    return {
      filed: true,
      title,
      bodyMarkdown,
      verdict,
      recommendation,
      sessionId: ctx.session.id,
    };
  },
});
