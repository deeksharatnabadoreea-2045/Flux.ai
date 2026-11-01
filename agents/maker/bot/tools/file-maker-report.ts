import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const Recommendation = z.enum(["go", "wait", "ignore"]);

export default defineTool({
  description: "File the Maker deliverable for orchestrator review.",
  effect: "write",
  inputSchema: z.object({
    title: z.string().min(8).max(120),
    bodyMarkdown: z.string().min(200),
    recommendation: Recommendation,
  }),
  async execute({ title, bodyMarkdown, recommendation }, ctx) {
    const key = `maker:${ctx.session.id}:latest`;
    await ctx.host.kv.put(key, {
      title,
      bodyMarkdown,
      recommendation,
      filedAt: new Date().toISOString(),
      sessionId: ctx.session.id,
    });
    return { filed: true, title, bodyMarkdown, recommendation, sessionId: ctx.session.id };
  },
});
