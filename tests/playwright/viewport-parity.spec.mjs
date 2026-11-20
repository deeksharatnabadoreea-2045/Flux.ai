import { expect, test } from "@playwright/test";

const SHARED = {
  title: /Flux — human body/,
  stamp: "prod-2026-11-20-redeploy",
};

test.describe("one Flux site — desktop layout at all viewport widths", () => {
  test("loads the same build and keeps desktop sections", async ({ page }, testInfo) => {
    const width = page.viewportSize()?.width ?? 0;
    const narrow = width <= 900;

    await page.goto("./index.html");

    await expect(page).toHaveTitle(SHARED.title);
    await expect(page.locator('meta[name="flux-deploy-stamp"]')).toHaveAttribute(
      "content",
      SHARED.stamp,
    );
    await expect(page.locator('link[href*="landing.css"]')).toHaveAttribute(
      "href",
      /landing\.css\?v=layout-parity-1/,
    );
    await expect(page.locator('script[src*="landing.js"]')).toHaveAttribute(
      "src",
      /landing\.js\?v=layout-parity-1/,
    );

    const workers = await page.evaluate(() => "serviceWorker" in navigator && !!navigator.serviceWorker.controller);
    expect(workers).toBe(false);

    await expect(page.locator(".hero-title")).toBeVisible();
    await expect(page.locator(".hero-sub")).toContainText("human body and its molecules");
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#access-open")).toHaveText("Get access");
    await expect(page.locator(".landing-footer .brand-mark")).toBeVisible();
    await expect(page.locator(".landing-footer .brand-mark")).toHaveText("Flux");

    const newChat = page.locator(".nav-item", { hasText: "New Chat" });
    const chats = page.locator("#chat-list-toggle");

    await page.screenshot({
      path: `/opt/cursor/artifacts/layout-${narrow ? "375" : "1440"}.png`,
      fullPage: false,
    });

    await expect(page.locator("#sidebar-toggle")).toBeHidden();

    await expect(newChat).toBeVisible();
    await expect(chats).toBeVisible();
    await expect(page.locator(".brand").first()).toHaveText("Flux");

    expect(testInfo.project.name === "mobile" ? narrow : !narrow).toBe(true);
  });
});
