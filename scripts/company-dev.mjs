#!/usr/bin/env node
/**
 * Flux.ai HQ + multi-agent dev proxy (all desks).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlaybook } from "../js/desks.js";
import { materializeEvolution } from "./materialize-evolution.mjs";
import { AGENT_DESK_IDS } from "../js/agent-desks.js";
import {
  readLinkedSourcesConfig,
  syncLinkedSources,
  writeLinkedSourcesConfig,
} from "../js/linked-sources-sync.mjs";
import { getIdentity } from "../cursor/identity.js";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
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
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FLUX_REPO_ROOT: ROOT },
    },
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

function playbookFallback(deskId, brief, company, evolution, reason) {
  const playbook = runPlaybook(deskId, brief, company, evolution);
  return { ...playbook, source: "playbook", reason };
}

function deskPlaybookMeta(deskId, brief, company, evolution) {
  const playbook = runPlaybook(deskId, brief, company, evolution);
  return { steps: playbook.steps, kind: playbook.kind, title: playbook.title };
}

async function ensureAgentPool() {
  if (!hasCursorCredential()) {
    return { ready: false, reason: "no_cursor_credential" };
  }
  startAgentsServe();
  const ready = await waitForAgents();
  return ready ? { ready: true } : { ready: false, reason: "agents_not_ready" };
}

async function readAgentSessionChunk(deskId, sessionId, startIndex = 0) {
  const toolName = fileToolForDesk(deskId);
  const base = `${AGENTS_BASE}/${deskId}`;
  const url = `${base}/v1/session/${sessionId}/events?format=json&startIndex=${startIndex}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, status: res.status, nextIndex: startIndex, done: false };
  }
  const payload = await res.json();
  const events = payload.events ?? [];
  let nextIndex = startIndex;
  let filed = null;
  let assistantText = "";
  let turnCompleted = false;
  for (const event of events) {
    nextIndex = Math.max(nextIndex, (event.index ?? nextIndex) + 1);
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
    if (type === "turn.completed") turnCompleted = true;
  }
  if (turnCompleted) {
    if (filed?.body) {
      return { ok: true, nextIndex, done: true, ...filed, source: "agent" };
    }
    if (assistantText) {
      return {
        ok: true,
        nextIndex,
        done: true,
        title: `${deskId}: ${assistantText.split("\n")[0].slice(0, 72)}`,
        body: assistantText,
        source: "agent",
      };
    }
    return { ok: true, nextIndex, done: true, source: "agent", title: "", body: "" };
  }
  return { ok: true, nextIndex, done: false, filedPreview: filed };
}

async function pollAgentSession(deskId, sessionId, maxMs = 180_000, startIndex = 0) {
  const start = Date.now();
  let lastIndex = startIndex;
  while (Date.now() - start < maxMs) {
    const chunk = await readAgentSessionChunk(deskId, sessionId, lastIndex);
    if (!chunk.ok) {
      await sleep(800);
      continue;
    }
    lastIndex = chunk.nextIndex;
    if (chunk.done) {
      return {
        title: chunk.title,
        body: chunk.body,
        source: chunk.source ?? "agent",
      };
    }
    await sleep(900);
  }
  throw new Error(`${deskId} agent timed out waiting for a filed report.`);
}

async function startDeskAgentSession(deskId, brief, company, jobId, evolution = {}) {
  if (!AGENT_DESK_IDS.includes(deskId)) {
    throw new Error("unknown_desk");
  }
  const pool = await ensureAgentPool();
  if (!pool.ready) {
    return playbookFallback(deskId, brief, company, evolution, pool.reason);
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
    return playbookFallback(deskId, brief, company, evolution, `channel_${res.status}`);
  }
  const opened = await res.json();
  return {
    source: "agent",
    sessionId: opened.sessionId,
    playgroundUrl: opened.playgroundUrl,
  };
}

async function runDeskAgent(deskId, brief, company, jobId, evolution = {}) {
  const started = await startDeskAgentSession(deskId, brief, company, jobId, evolution);
  if (started.source === "playbook") return started;
  const filed = await pollAgentSession(deskId, started.sessionId);
  const meta = deskPlaybookMeta(deskId, brief, company, evolution);
  return {
    title: filed.title,
    body: filed.body,
    steps: meta.steps,
    kind: meta.kind,
    source: filed.source ?? "agent",
  };
}

function isPathInsideRoot(filePath) {
  const resolved = resolve(filePath);
  return resolved === ROOT || resolved.startsWith(`${ROOT}${sep}`);
}

async function readStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Absolute URL paths must not be passed to path.join as-is (join discards ROOT).
  const stripped = normalize(decoded).replace(/^([/\\])+/, "").replace(/^(\.\.([/\\]|$))+/, "");
  const rel = !stripped || stripped === "." ? "index.html" : stripped;
  let filePath = resolve(ROOT, rel);
  if (!isPathInsideRoot(filePath)) return null;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      if (!isPathInsideRoot(filePath)) return null;
    }
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

async function requireApiViewer(req, res) {
  const identity = await getIdentity(req);
  if (!identity.verified) {
    res.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: "unauthorized",
        reason: identity.reason ?? "missing_identity",
      }),
    );
    return null;
  }
  return identity;
}

function jsonHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "cache-control": "private, no-store",
    ...extra,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const identity = await requireApiViewer(req, res);
    if (!identity) return;
  }

  if (req.method === "POST" && url.pathname === "/api/evolution/materialize") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw || "{}");
      const out = await materializeEvolution(payload.applied ?? []);
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, ...out }));
    } catch (error) {
      res.writeHead(500, jsonHeaders());
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "materialize_failed",
        }),
      );
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/linked-sources") {
    const config = await readLinkedSourcesConfig(ROOT);
    let manifest = null;
    try {
      manifest = JSON.parse(
        await readFile(join(ROOT, ".flux/source-snapshots/manifest.json"), "utf8"),
      );
    } catch {
      /* no sync yet */
    }
    res.writeHead(200, jsonHeaders());
    res.end(JSON.stringify({ ok: true, config, manifest }));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/linked-sources") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw || "{}");
      const config = await writeLinkedSourcesConfig(ROOT, {
        version: 1,
        sources: payload.sources ?? [],
      });
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, config }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "save_failed";
      const clientError = [
        "invalid_url",
        "invalid_scheme",
        "credentials_forbidden",
        "blocked_host",
      ].includes(message);
      res.writeHead(clientError ? 400 : 500, jsonHeaders());
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/linked-sources/sync") {
    try {
      const manifest = await syncLinkedSources(ROOT);
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, manifest }));
    } catch (error) {
      res.writeHead(500, jsonHeaders());
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "sync_failed",
        }),
      );
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agents/health") {
    const credentialed = hasCursorCredential();
    if (credentialed) startAgentsServe();
    const ready = credentialed ? await waitForAgents(credentialed ? 8_000 : 0) : false;
    let agents = [];
    if (ready) {
      try {
        const agentRes = await fetch(`${AGENTS_BASE}/v1/agents`);
        if (agentRes.ok) {
          const payload = await agentRes.json();
          agents = payload.agents ?? payload ?? [];
        }
      } catch {
        /* pool not up */
      }
    }
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        ok: true,
        runtimeRoot: "agents24x7",
        credentialed,
        poolReady: ready,
        agentsBase: AGENTS_BASE,
        desks: AGENT_DESK_IDS,
        agents: Array.isArray(agents)
          ? agents.map((a) => ({
              id: a.id ?? a.slug ?? a.name,
              schedules: a.schedules ?? undefined,
            }))
          : [],
        patrolSchedule: "patrol",
        note: credentialed
          ? ready
            ? "Agent pool is up. Hosted deploy runs patrol schedules 24/7."
            : "Agent pool starting or unavailable."
          : "Set CURSOR_API_KEY or service account for live agents; HQ uses playbooks as fallback.",
      }),
    );
    return;
  }

  const deskStartMatch = url.pathname.match(/^\/api\/desk\/([a-z]+)\/start$/);
  if (req.method === "POST" && deskStartMatch) {
    const deskId = deskStartMatch[1];
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw);
      const brief = String(payload.brief ?? "").trim();
      const company = payload.company ?? {};
      const evolution = payload.evolution ?? {};
      const jobId = payload.jobId ?? "";
      if (!brief) {
        res.writeHead(400, jsonHeaders());
        res.end(JSON.stringify({ ok: false, error: "brief_required" }));
        return;
      }
      const started = await startDeskAgentSession(deskId, brief, company, jobId, evolution);
      if (started.source === "playbook") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...started }));
        return;
      }
      const meta = deskPlaybookMeta(deskId, brief, company, evolution);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          source: "agent",
          sessionId: started.sessionId,
          playgroundUrl: started.playgroundUrl,
          steps: meta.steps,
          kind: meta.kind,
        }),
      );
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "desk_start_failed",
        }),
      );
    }
    return;
  }

  const deskSessionMatch = url.pathname.match(/^\/api\/desk\/([a-z]+)\/session\/([^/]+)$/);
  if (req.method === "GET" && deskSessionMatch) {
    const deskId = deskSessionMatch[1];
    const sessionId = deskSessionMatch[2];
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    const wait = url.searchParams.get("wait") === "1";
    try {
      if (wait) {
        const filed = await pollAgentSession(deskId, sessionId, 180_000, startIndex);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, done: true, ...filed }));
        return;
      }
      const chunk = await readAgentSessionChunk(deskId, sessionId, startIndex);
      if (!chunk.ok) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `session_${chunk.status}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          done: chunk.done,
          nextIndex: chunk.nextIndex,
          title: chunk.title,
          body: chunk.body,
          source: chunk.source,
        }),
      );
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "desk_poll_failed",
        }),
      );
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/briefs/parallel") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const payload = JSON.parse(raw);
      const company = payload.company ?? {};
      const evolution = payload.evolution ?? {};
      const wait = payload.wait !== false;
      const items = Array.isArray(payload.briefs) ? payload.briefs : [];
      if (!items.length) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "briefs_required" }));
        return;
      }
      const runners = items.map(async (item) => {
        const deskId = String(item.deskId ?? "").trim();
        const brief = String(item.brief ?? "").trim();
        const jobId = item.jobId ?? "";
        if (!deskId || !brief) {
          return { ok: false, deskId, error: "desk_and_brief_required" };
        }
        try {
          if (!wait) {
            const started = await startDeskAgentSession(deskId, brief, company, jobId, evolution);
            if (started.source === "playbook") return { ok: true, deskId, ...started };
            const meta = deskPlaybookMeta(deskId, brief, company, evolution);
            return {
              ok: true,
              deskId,
              source: "agent",
              sessionId: started.sessionId,
              playgroundUrl: started.playgroundUrl,
              steps: meta.steps,
              kind: meta.kind,
            };
          }
          const result = await runDeskAgent(deskId, brief, company, jobId, evolution);
          return { ok: true, deskId, ...result };
        } catch (error) {
          return {
            ok: false,
            deskId,
            error: error instanceof Error ? error.message : "desk_failed",
          };
        }
      });
      const results = await Promise.all(runners);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "parallel_briefs_failed",
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
      const wait = payload.wait !== false;
      if (!brief) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "brief_required" }));
        return;
      }
      if (!wait) {
        const started = await startDeskAgentSession(deskId, brief, company, jobId, evolution);
        if (started.source === "playbook") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...started }));
          return;
        }
        const meta = deskPlaybookMeta(deskId, brief, company, evolution);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            source: "agent",
            sessionId: started.sessionId,
            playgroundUrl: started.playgroundUrl,
            steps: meta.steps,
            kind: meta.kind,
          }),
        );
        return;
      }
      const result = await runDeskAgent(deskId, brief, company, jobId, evolution);
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.writeHead(500, jsonHeaders());
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

const SOURCE_SYNC_MS = Number(process.env.FLUX_SOURCE_SYNC_MS ?? 4 * 60 * 60 * 1000);
const SOURCE_SYNC_OFF = process.env.FLUX_SOURCE_SYNC === "0";

async function maybeSyncLinkedSources(reason) {
  const config = await readLinkedSourcesConfig(ROOT);
  if (!config.sources.length) return;
  try {
    const manifest = await syncLinkedSources(ROOT);
    console.log(
      `[sources] synced ${manifest.count} link(s) (${reason}) at ${manifest.syncedAt}`,
    );
  } catch (error) {
    console.warn(
      `[sources] sync failed (${reason}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

server.listen(HQ_PORT, "127.0.0.1", () => {
  console.log(`Flux.ai HQ     http://127.0.0.1:${HQ_PORT}`);
  console.log(`Agent pool     ${AGENTS_BASE} (multi; 24/7 root — patrol schedules on hosted deploy)`);
  console.log(`Health         http://127.0.0.1:${HQ_PORT}/api/agents/health`);
  console.log(`Linked sources http://127.0.0.1:${HQ_PORT}/api/linked-sources`);
  console.log(`Desks: ${AGENT_DESK_IDS.join(", ")}`);
  if (hasCursorCredential()) {
    startAgentsServe();
    waitForAgents().then((ready) => {
      if (ready) console.log("[agents] pool ready");
      else console.warn("[agents] pool not ready — briefs may fall back to playbooks");
    });
  } else {
    console.log("[agents] no Cursor credential — live pool idle; playbooks only");
  }
  if (!SOURCE_SYNC_OFF) {
    setTimeout(() => maybeSyncLinkedSources("startup"), 12_000);
    setInterval(() => maybeSyncLinkedSources("interval"), SOURCE_SYNC_MS);
  }
});

process.on("SIGINT", () => {
  agentsChild?.kill();
  process.exit(0);
});
