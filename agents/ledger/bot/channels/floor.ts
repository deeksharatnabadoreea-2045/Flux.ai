import { defineChannel, localDev, POST } from "@grok/agent-sdk/channels";
import * as z from "zod/v4";

const BriefBody = z.object({
  brief: z.string().min(1),
  companyName: z.string().default("Flux.ai"),
  mission: z.string().default(""),
  orchestrator: z.string().default("Orchestrator"),
  jobId: z.string().optional(),
});

export default defineChannel({
  auth: [localDev()],
  routes: [
    POST("/brief", {
      description: "Issue a research brief from the Flux.ai company floor",
      bodySchema: BriefBody,
      handler: async (_req, route) => {
        const { brief, companyName, mission, orchestrator, jobId } = route.body;
        const message = [
          `Orchestrator: ${orchestrator}`,
          `Company: ${companyName}`,
          mission ? `Mission: ${mission}` : "",
          "",
          `Brief: ${brief}`,
        ]
          .filter(Boolean)
          .join("\n");

        const continuationToken = jobId ? `floor:${jobId}` : undefined;
        const session = await route.send(message, {
          title: `Scout · ${brief.slice(0, 64)}`,
          continuationToken,
        });

        return Response.json({
          ok: true,
          sessionId: session.id,
          playgroundUrl: route.sessionUrls(_req, session.id).playgroundUrl,
        });
      },
    }),
  ],
});
