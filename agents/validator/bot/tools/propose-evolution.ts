import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const ChangeKind = z.enum([
  "instructions",
  "tool",
  "architecture",
  "eval",
  "routing",
  "playbook",
]);

export default defineTool({
  description:
    "Propose a self-improvement or architecture change for orchestrator review. Does not apply until accepted on the company floor.",
  effect: "write",
  inputSchema: z.object({
    targetDesk: z.string().describe("Desk id (scout, maker, voice, all, company, …)"),
    changeKind: ChangeKind,
    title: z.string().min(8).max(120),
    hypothesis: z.string().min(20),
    change: z.string().min(20),
    metric: z.string().min(10),
    rollback: z.string().min(10),
    patch: z.string().min(40),
  }),
  async execute(input, ctx) {
    const id = `evo_${ctx.session.id}_${Date.now()}`;
    await ctx.host.kv.put(`evolution:proposal:${id}`, {
      ...input,
      id,
      sessionId: ctx.session.id,
      proposedAt: new Date().toISOString(),
      status: "proposed",
    });
    return {
      proposed: true,
      id,
      title: input.title,
      targetDesk: input.targetDesk,
      message:
        "Proposal stored. Orchestrator must accept on the Flux.ai floor (Forge desk) before it applies.",
    };
  },
});
