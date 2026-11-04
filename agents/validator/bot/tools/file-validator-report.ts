import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fluxRepoRoot } from "../lib/repo-root.ts";

const Verdict = z.enum(["ship", "fix", "block"]);
const Recommendation = z.enum(["go", "wait", "ignore"]);

const ScientificMethodAttestation = z.object({
  hypothesisStated: z.literal(true),
  observationsSeparateFromInference: z.literal(true),
  falsifiabilityDocumented: z.literal(true),
  noFabricatedEvidence: z.literal(true),
});

export default defineTool({
  description:
    "File a scientific-method Validator audit. All sections required; fake science must be block.",
  effect: "write",
  inputSchema: z.object({
    title: z.string().min(8).max(120),
    bodyMarkdown: z.string().min(400),
    verdict: Verdict,
    recommendation: Recommendation,
    fakeScienceDetected: z.boolean(),
    fakeScienceNotes: z.string().optional(),
    scientificMethodAttestation: ScientificMethodAttestation,
  }),
  async execute(input, ctx) {
    const root = fluxRepoRoot();
    const mod = await import(
      pathToFileURL(join(root, "js/scientific-method.js")).href
    );
    const check = mod.validateScientificMethodReport({
      bodyMarkdown: input.bodyMarkdown,
      fakeScienceDetected: input.fakeScienceDetected,
      verdict: input.verdict,
    });
    if (!check.ok) {
      throw new Error(
        `Scientific-method audit incomplete: ${check.errors.join("; ")}. See docs/SCIENTIFIC-METHOD.md`,
      );
    }
    if (!input.scientificMethodAttestation.noFabricatedEvidence) {
      throw new Error("noFabricatedEvidence must be true to file — rewrite or block.");
    }

    const key = `validator:${ctx.session.id}:latest`;
    await ctx.host.kv.put(key, {
      ...input,
      filedAt: new Date().toISOString(),
      sessionId: ctx.session.id,
    });
    return {
      filed: true,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      verdict: input.verdict,
      recommendation: input.recommendation,
      fakeScienceDetected: input.fakeScienceDetected,
      sessionId: ctx.session.id,
    };
  },
});
