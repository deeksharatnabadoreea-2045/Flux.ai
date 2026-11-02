#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DESK_IDS } from "../js/agent-desks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "scripts/desk-heartbeat.md");

/** Stagger patrol fires (UTC cron, every 6 hours). */
const CRON_BY_DESK = {
  scout: "0 */6 * * *",
  maker: "10 */6 * * *",
  voice: "20 */6 * * *",
  floor: "30 */6 * * *",
  ledger: "40 */6 * * *",
  wire: "50 */6 * * *",
  forge: "5 */6 * * *",
};

const template = await readFile(TEMPLATE, "utf8");

for (const deskId of AGENT_DESK_IDS) {
  const cron = CRON_BY_DESK[deskId] ?? "0 */6 * * *";
  const body = template.replace("{{CRON}}", cron);
  const dir = join(ROOT, "agents", deskId, "bot/schedules");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "patrol.md"), body);
  console.log(`wrote agents/${deskId}/bot/schedules/patrol.md (${cron})`);
}
