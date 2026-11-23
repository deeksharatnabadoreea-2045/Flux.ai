import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.FLUX_PLAYWRIGHT_PORT ?? 4177);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests/playwright",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
  },
  webServer: {
    command: "node scripts/company-dev.mjs",
    url: `${BASE}/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      FLUX_HQ_PORT: String(PORT),
      // Force anonymous local identity path for public-chat Playwright coverage.
      CURSOR_APP_ID: "playwright_public_chat",
      CHAT_SESSION_SECRET: "playwright-session-secret",
      // Durable rate store required when CURSOR_APP_ID is set (fail-closed otherwise).
      DATABASE_URL: "pglite://playwright-flux",
      // Leave GROQ_API_KEY unset unless the environment already provides it —
      // PubChem fallback still returns a real science reply for molecule asks.
    },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
