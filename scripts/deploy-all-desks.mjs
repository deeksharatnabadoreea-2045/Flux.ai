#!/usr/bin/env node
/**
 * Validate all desk agents and print deploy commands for 24/7 hosting.
 * Does not deploy unless DEPLOY=1 and Cursor service account is configured.
 */
import { spawnSync } from "node:child_process";
import { AGENT_DESK_IDS } from "../js/agent-desks.js";

const BDK = ["npx", "--yes", "@grok/agent-sdk@0.5.0"];
const ref = process.env.SOURCE_REF ?? spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

let failed = false;
for (const desk of AGENT_DESK_IDS) {
  const dir = `agents/${desk}`;
  const v = spawnSync(BDK[0], [...BDK.slice(1), "validate", "--dir", dir], {
    stdio: "inherit",
  });
  if (v.status !== 0) failed = true;
}

if (failed) process.exit(1);

console.log("\nAll desks validated. Deploy each for 24/7 patrol + floor channel:\n");
for (const desk of AGENT_DESK_IDS) {
  console.log(`npx @grok/agent-sdk deploy --dir agents/${desk} --ref ${ref}`);
}

if (process.env.DEPLOY === "1") {
  if (!process.env.CURSOR_SERVICE_ACCOUNT_KEY) {
    console.error("\nSet CURSOR_SERVICE_ACCOUNT_KEY to deploy from this script.");
    process.exit(1);
  }
  for (const desk of AGENT_DESK_IDS) {
    const d = spawnSync(
      BDK[0],
      [...BDK.slice(1), "deploy", "--dir", `agents/${desk}`, "--ref", ref],
      { stdio: "inherit", env: process.env },
    );
    if (d.status !== 0) process.exit(d.status ?? 1);
  }
}
