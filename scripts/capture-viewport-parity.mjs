import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PORT = 4178;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR =
  process.env.FLUX_PARITY_SCREENSHOT_DIR ??
  "/cursor/stores/bc-fc19adb9-4066-4dbb-a54f-9416f0698751/media";

const PREFIX = process.env.FLUX_PARITY_PREFIX ?? "mobile-parity-before";

const viewports = [
  { w: 375, h: 812 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/index.html`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server did not start");
}

const server = spawn("node", ["scripts/company-dev.mjs"], {
  cwd: REPO,
  env: { ...process.env, FLUX_HQ_PORT: String(PORT) },
  stdio: "pipe",
});

try {
  await waitForServer();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const { w, h } of viewports) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    await page.screenshot({
      path: join(OUT_DIR, `${PREFIX}-${w}.png`),
      fullPage: false,
    });
    await page.close();
  }
  await browser.close();
  console.log(`Saved screenshots to ${OUT_DIR} with prefix ${PREFIX}`);
} finally {
  server.kill("SIGTERM");
}