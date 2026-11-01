#!/usr/bin/env node
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const AGENTS = [
  { id: "maker", title: "Maker", role: "product specs and build order" },
  { id: "voice", title: "Voice", role: "copy and public sentences" },
  { id: "floor", title: "Floor", role: "operations checklists and cadence" },
  { id: "ledger", title: "Ledger", role: "metrics, pricing, and kill criteria" },
  { id: "wire", title: "Wire", role: "outbound asks and drafts" },
  { id: "forge", title: "Forge", role: "evolution and architecture proposals" },
];

const PACKAGE = {
  private: true,
  type: "module",
  scripts: { check: "tsc --noEmit", dev: "agent-sdk dev" },
  dependencies: { "@grok/agent-sdk": "^0.5.0", zod: "^4.6.5" },
  devDependencies: { "@types/node": "^22.14.0", typescript: "6.0.3" },
};

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    rootDir: ".",
  },
  include: ["bot/**/*.ts", "evals/**/*.ts"],
};

const AGENT_TS = `import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: {
    id: "grok-4.7",
    params: [
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
});
`;

const MEMORY_HOOK = `import { defineHook } from "@grok/agent-sdk/hooks";

export default defineHook({});
`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function instructions(desk) {
  return `# ${desk.title} — Flux.ai desk

You are **${desk.title}**. The orchestrator assigns briefs; you **file** structured work they can accept, return, or kill.

Role: ${desk.role}.

Before you finish, call \`file_${desk.id}_report\` once with \`title\`, \`bodyMarkdown\`, and \`recommendation\` (\`go\` | \`wait\` | \`ignore\`).

## Recursive self-improvement

You must be able to improve yourself over time:

- If output quality stalls, call \`propose_evolution\` with one lever, a metric, patch text, and rollback.
- Never apply changes yourself — the orchestrator accepts on the company floor.
- After accept, read \`evolution-appendix.md\` in this folder; it overrides conflicting guidance.

Use the \`self-improve\` skill when the brief mentions evolution, architecture, or hillclimbing.
`;
}

function fileTool(desk) {
  return `import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";

const Recommendation = z.enum(["go", "wait", "ignore"]);

export default defineTool({
  description: "File the ${desk.title} deliverable for orchestrator review.",
  effect: "write",
  inputSchema: z.object({
    title: z.string().min(8).max(120),
    bodyMarkdown: z.string().min(200),
    recommendation: Recommendation,
  }),
  async execute({ title, bodyMarkdown, recommendation }, ctx) {
    const key = \`${desk.id}:\${ctx.session.id}:latest\`;
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
`;
}

async function scaffoldDesk(desk, shared) {
  const dir = join(ROOT, "agents", desk.id);
  if (desk.id === "scout") return;
  if (await exists(join(dir, "bot/agent.ts"))) {
    console.log(`skip ${desk.id} (exists)`);
    return;
  }
  await mkdir(join(dir, "bot/tools"), { recursive: true });
  await mkdir(join(dir, "bot/skills/self-improve"), { recursive: true });
  await mkdir(join(dir, "bot/channels"), { recursive: true });
  await mkdir(join(dir, "evals"), { recursive: true });
  await mkdir(join(dir, "bot/hooks"), { recursive: true });

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ ...PACKAGE, name: desk.id, description: `Flux.ai ${desk.title} desk` }, null, 2),
  );
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));
  await writeFile(join(dir, ".gitignore"), "node_modules\n.env\n.agent-serve\nbot/evolution-appendix.md\n");
  await writeFile(join(dir, "bot/agent.ts"), AGENT_TS);
  await writeFile(join(dir, "bot/instructions.md"), instructions(desk));
  await writeFile(join(dir, `bot/tools/file-${desk.id}-report.ts`), fileTool(desk));
  await writeFile(join(dir, "bot/tools/propose-evolution.ts"), shared.proposeEvolution);
  await writeFile(join(dir, "bot/channels/floor.ts"), shared.floorChannel);
  await writeFile(join(dir, "bot/skills/self-improve/SKILL.md"), shared.selfImproveSkill);
  await writeFile(join(dir, "bot/hooks/memory.ts"), MEMORY_HOOK);
  await writeFile(
    join(dir, "evals/smoke.eval.ts"),
    `import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "${desk.title} files work for the orchestrator.",
  async test(t) {
    await t.send("Brief: Smoke test for ${desk.title}. Company: Flux.ai.");
    t.succeeded();
    t.calledTool("file_${desk.id}_report");
  },
});
`,
  );
  await writeFile(join(dir, "evals/evals.config.ts"), `export default { maxConcurrency: 20 };\n`);
  console.log(`scaffolded agents/${desk.id}`);
}

const shared = {
  proposeEvolution: await readFile(join(ROOT, "agents/scout/bot/tools/propose-evolution.ts"), "utf8"),
  floorChannel: await readFile(join(ROOT, "agents/scout/bot/channels/floor.ts"), "utf8"),
  selfImproveSkill: await readFile(join(ROOT, "agents/scout/bot/skills/self-improve/SKILL.md"), "utf8"),
};

for (const desk of AGENTS) {
  await scaffoldDesk(desk, shared);
}

console.log("done");
