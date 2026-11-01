#!/usr/bin/env node
/**
 * Flux.ai HQ + multi-agent dev proxy (all desks).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlaybook } from "../js/desks.js";
import { materializeEvolution } from "./materialize-evolution.mjs";
import { AGENT_DESK_IDS } from "../js/agent-desks.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HQ_PORT = Number(process.env.FLUX_HQ_PORT ?? 4173);
const AGENTS_PORT = Number(process.env.FLUX_AGENTS_PORT ?? 3000);
const AGENTS_BASE = `http://127.0.0.1:${AGENTS_PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webp": "image/webp",
};

let agentsChild = null;

function hasCursorCredential() {
  return Boolean(
    process.env.CURSOR_API_KEY ||
      process.env.CURSOR_API_KEY_FILE ||
      process.env.CURSOR_SERVICE_ACCOUNT_KEY,
  );
}

function startAgentsServe() {
  if (agentsChild) return;
  agentsChild = spawn(
    "npx",
    [
      "--yes",
      "@grok/agent-sdk@0.5.0",
      "serve",
      "--dir",
      join(ROOT, "agents"),
      "--port",
      String(AGENTS_PORT),
      "--host",
      "127.0.0.1",
      "--mode",
      "multi",
      "--dev",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  agentsChild.stderr?.on("data", (chunk) => {
    const line = String(chunk);
    if (line.includes("listening") || line.includes("error")) {
      process.stderr.write(`[agents] ${line}`);
    }
  });
}

async function waitForAgents(maxMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${AGENTS_BASE}/v1/agents`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileToolForDesk(deskId) {
  return `file_${deskId}_report`;
}

async function pollAgentSession(deskId, sessionId, maxMs = 180_000) {
  const toolName = fileToolForDesk(deskId);
  const start = Date.now();
  let lastIndex = 0;
  let filed = null;
  let assistantText = "";
  const base = `${AGENTS_BASE}/${deskId}`;

  while (Date.now() - start < maxMs) {
    const url = `${base}/v1/session/${sessionId}/events?format=json&startIndex=${lastIndex}`;
    const res = await fetch(url);
    if (!res.ok) {
      await sleep(800);
      continue;
    }
    const payload = await res.json();
    const events = payload.events ?? [];
    for (const event of events) {
      lastIndex = Math.max(lastIndex, (event.index ?? lastIndex) + 1);
      const type = event.type ?? event.kind;
      if (type === "action.result" && event.data?.toolName === toolName) {
        const result = event.data.output ?? event.data.result;
        if (result?.title && result?.bodyMarkdown) {
          filed = { title: result.title, body: result.bodyMarkdown };
        }
      }
      if (type === "message.completed" && event.data?.text) {
        assistantText = event.data.text;
      }
      if (type === "turn.completed") {
        if (filed?.body) return { ...filed, source: "agent" };
        if (assistantText) {
          return {
            title: `${deskId}: ${assistantText.split("\n")[0].slice(0, 72)}`,
            body: assistantText,
            source: "agent",
          };
        }
      }
    }
    await sleep(900);
  }
  throw new Error(`${deskId} agent timed out waiting for a filed report.`);
}

async function runDeskAgent(deskId, brief, company, jobId, evolution = {}) {
  if (!AGENT_DESK_IDS.includes(deskId)) {
    throw new Error("unknown_desk");
  }
  if (!hasCursorCredential()) {
    const playbook = runPlaybook(deskId, brief, company, evolution);
    return { ...playbook, source: "playbook", reason: "no_cursor_credential" };
  }
  startAgentsServe();
  const ready = await waitForAgents();
  if (!ready) {
    const playbook = runPlaybook(deskId, brief, company, evolution);
    return { ...playbook, source: "playbook", reason: "agents_not_ready" };
  }

  const res = await fetch(`${AGENTS_BASE}/${deskId}/v1/channels/floor/brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brief,
      companyName: company.name,
      mission: company.mission,
      orchestrator: company.orchestrator,
      jobId,
    }),
  });
  if (!res.ok) {
    const playbook = runPlaybook(deskId, brief, company, evolution);
    return { ...playbook, source: "playbook", reason: `channel_${res.status}` };
  }
  const opened = await res.json();
  const filed = await pollAgentSession(deskId, opened.sessionId);
  return {
    title: filed.title,
    body: filed.body,
    steps: runPlaybook(deskId, brief, company, evolution).steps,
    kind: runPlaybook(deskId, brief, company, evolution).kind,
    source: filed.source ?? "agent",
  };
}

async function readStatic(pathname) {
  const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(ROOT, safe === "/" ? "index.html" : safe);
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    return null;
  }
  try {
    const body = await readFile(filePath);
    return { body, type: MIME[extname(filePath)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/evolution/materialize") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw || "{}");
      const out = await materializeEvolution(payload.applied ?? []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...out }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "materialize_failed",
        }),
      );
    }
    return;
  }

  const deskMatch = url.pathname.match(/^\/api\/desk\/([a-z]+)$/);
  if (req.method === "POST" && deskMatch) {
    const deskId = deskMatch[1];
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw);
      const brief = String(payload.brief ?? "").trim();
      const company = payload.company ?? {};
      const evolution = payload.evolution ?? {};
      const jobId = payload.jobId ?? "";
      if (!brief) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "brief_required" }));
        return;
      }
      const result = await runDeskAgent(deskId, brief, company, jobId, evolution);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "desk_failed",
        }),
      );
    }
    return;
  }

  const file = await readStatic(url.pathname);
  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": file.type });
  res.end(file.body);
});

server.listen(HQ_PORT, "127.0.0.1", () => {
  console.log(`Flux.ai HQ     http://127.0.0.1:${HQ_PORT}`);
  console.log(`Agent pool     ${AGENTS_BASE} (multi; starts on first live brief when credentialed)`);
  console.log(`Desks: ${AGENT_DESK_IDS.join(", ")}`);
});

process.on("SIGINT", () => {
  agentsChild?.kill();
  process.exit(0);
});
