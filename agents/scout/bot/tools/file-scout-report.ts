import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const Recommendation = z.enum(["go", "wait", "ignore"]);

export default defineTool({
  description:
    "File the Scout research report for the orchestrator to review. Call once per brief with the full markdown body.",
  effect: "write",
  inputSchema: z.object({
    title: z.string().min(8).max(120),
    bodyMarkdown: z.string().min(200),
    recommendation: Recommendation,
  }),
  async execute({ title, bodyMarkdown, recommendation }, ctx) {
    const key = `scout:${ctx.session.id}:latest`;
    const record = {
      title,
      bodyMarkdown,
      recommendation,
      filedAt: new Date().toISOString(),
      sessionId: ctx.session.id,
    };
    await ctx.host.kv.put(key, record);
    return {
      filed: true,
      title,
      bodyMarkdown,
      recommendation,
      sessionId: ctx.session.id,
    };
  },
});
