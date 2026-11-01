#!/usr/bin/env node
/**
 * Serves the Flux.ai HQ and proxies Scout agent briefs on the same origin.
 * Starts Scout locally when CURSOR_API_KEY (or login) is available.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlaybook } from "../js/desks.js";
import { materializeEvolution } from "./materialize-evolution.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HQ_PORT = Number(process.env.FLUX_HQ_PORT ?? 4173);
const SCOUT_PORT = Number(process.env.FLUX_SCOUT_PORT ?? 3000);
const SCOUT_BASE = `http://127.0.0.1:${SCOUT_PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webp": "image/webp",
};

let scoutChild = null;

function hasCursorCredential() {
  return Boolean(
    process.env.CURSOR_API_KEY ||
      process.env.CURSOR_API_KEY_FILE ||
      process.env.CURSOR_SERVICE_ACCOUNT_KEY,
  );
}

function startScoutServe() {
  if (scoutChild) return;
  scoutChild = spawn(
    "npx",
    [
      "--yes",
      "@grok/agent-sdk@0.5.0",
      "serve",
      "--dir",
      join(ROOT, "agents/scout"),
      "--port",
      String(SCOUT_PORT),
      "--host",
      "127.0.0.1",
      "--mode",
      "single",
      "--dev",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  scoutChild.stderr?.on("data", (chunk) => {
    const line = String(chunk);
    if (line.includes("listening") || line.includes("error")) {
      process.stderr.write(`[scout] ${line}`);
    }
  });
}

async function waitForScout(maxMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${SCOUT_BASE}/v1/info`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollScoutSession(sessionId, maxMs = 180_000) {
  const start = Date.now();
  let lastIndex = 0;
  let filed = null;
  let assistantText = "";

  while (Date.now() - start < maxMs) {
    const url = `${SCOUT_BASE}/v1/session/${sessionId}/events?format=json&startIndex=${lastIndex}`;
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
      if (type === "action.result" && event.data?.toolName === "file_scout_report") {
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
            title: `Scout: ${assistantText.split("\n")[0].slice(0, 72)}`,
            body: assistantText,
            source: "agent",
          };
        }
      }
    }
    await sleep(900);
  }
  throw new Error("Scout agent timed out waiting for a filed report.");
}

async function runScoutAgent(brief, company, jobId) {
  if (!hasCursorCredential()) {
    const playbook = runPlaybook("scout", brief, company);
    return { ...playbook, source: "playbook", reason: "no_cursor_credential" };
  }
  startScoutServe();
  const ready = await waitForScout();
  if (!ready) {
    const playbook = runPlaybook("scout", brief, company);
    return { ...playbook, source: "playbook", reason: "scout_not_ready" };
  }

  const res = await fetch(`${SCOUT_BASE}/v1/channels/floor/brief`, {
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
    const playbook = runPlaybook("scout", brief, company);
    return { ...playbook, source: "playbook", reason: `channel_${res.status}` };
  }
  const opened = await res.json();
  const filed = await pollScoutSession(opened.sessionId);
  return {
    title: filed.title,
    body: filed.body,
    steps: runPlaybook("scout", brief, company).steps,
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

  if (req.method === "POST" && url.pathname === "/api/desk/scout") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw);
      const brief = String(payload.brief ?? "").trim();
      const company = payload.company ?? {};
      const jobId = payload.jobId ?? "";
      if (!brief) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "brief_required" }));
        return;
      }
      const result = await runScoutAgent(brief, company, jobId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "scout_failed",
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
  console.log(`Flux.ai HQ  http://127.0.0.1:${HQ_PORT}`);
  console.log(`Scout agent  ${SCOUT_BASE} (starts on first live Scout brief when credentialed)`);
});

process.on("SIGINT", () => {
  scoutChild?.kill();
  process.exit(0);
});
