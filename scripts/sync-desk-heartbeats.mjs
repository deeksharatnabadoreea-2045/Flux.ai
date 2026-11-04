#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DESK_IDS } from "../js/agent-desks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "scripts/desk-heartbeat.md");

/** All desks patrol in parallel (UTC cron, every 6 hours). Each desk is a separate hosted worker. */
const PATROL_CRON = "0 */6 * * *";

const template = await readFile(TEMPLATE, "utf8");

for (const deskId of AGENT_DESK_IDS) {
  const cron = PATROL_CRON;
  const body = template.replace("{{CRON}}", cron);
  const dir = join(ROOT, "agents", deskId, "bot/schedules");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "patrol.md"), body);
  console.log(`wrote agents/${deskId}/bot/schedules/patrol.md (${cron})`);
}
