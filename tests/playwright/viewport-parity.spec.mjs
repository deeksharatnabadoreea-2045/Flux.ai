import { expect, test } from "@playwright/test";

const SHARED = {
  title: /Flux — human body/,
  stamp: "prod-2026-11-23-chat-origin-mol-limits-1",
  cacheBust: "chat-origin-mol-limits-1",
};

test.describe("chat surface — same content at 375, 768, and 1440", () => {
  test("loads chat.html and keeps desktop-min layout", async ({ page }, testInfo) => {
    const width = page.viewportSize()?.width ?? 0;

    await page.goto("./chat.html");

    await expect(page).toHaveTitle(SHARED.title);
    await expect(page.locator('meta[name="flux-deploy-stamp"]')).toHaveAttribute(
      "content",
      SHARED.stamp,
    );
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /width=device-width/,
    );
    await expect(page.locator('link[href*="landing.css"]')).toHaveAttribute(
      "href",
      new RegExp(`landing\\.css\\?v=${SHARED.cacheBust}`),
    );
    await expect(page.locator('script[src*="landing.js"]')).toHaveAttribute(
      "src",
      new RegExp(`landing\\.js\\?v=${SHARED.cacheBust}`),
    );

    const workers = await page.evaluate(
      () => "serviceWorker" in navigator && !!navigator.serviceWorker.controller,
    );
    expect(workers).toBe(false);

    await expect(page.locator(".hero-title")).toBeVisible();
    await expect(page.locator(".hero-sub")).toContainText("human body and its molecules");
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#access-open")).toHaveText("Get access");
    await expect(page.locator("#flux-deploy-release")).toBeVisible();
    await expect(page.locator("#flux-deploy-release")).toHaveText(SHARED.stamp);
    await expect(page.locator(".landing-footer .brand-mark")).toBeVisible();
    await expect(page.locator(".landing-footer .brand-mark")).toHaveText("Flux");

    const newChat = page.locator(".nav-item", { hasText: "New Chat" });
    const chats = page.locator("#chat-list-toggle");
    const sidebarToggle = page.locator("#sidebar-toggle");

    await page.screenshot({
      path: `artifacts/chat-viewport-${testInfo.project.name}.png`,
      fullPage: false,
    });

    // PR #83: desktop shell on all widths — no mobile drawer toggle.
    await expect(sidebarToggle).toBeHidden();
    await expect(newChat).toBeVisible();
    await expect(chats).toBeVisible();

    await expect(page.locator(".brand").first()).toHaveText("Flux");

    const shellMinWidth = await page.evaluate(() => {
      const el = document.querySelector(".app-shell");
      return el ? parseFloat(getComputedStyle(el).minWidth) : 0;
    });
    expect(shellMinWidth).toBeGreaterThanOrEqual(1024);

    const projectWidth = { mobile: 375, tablet: 768, desktop: 1440 }[testInfo.project.name];
    expect(width).toBe(projectWidth);
  });
});

test.describe("marketing home", () => {
  test("loads unified homepage", async ({ page }) => {
    await page.goto("./");
    await expect(page).toHaveTitle(/biology meets intelligence/i);
    await expect(page.locator(".brand-signal")).toHaveText("Flux.ai");
    await expect(page.locator(".hero h1")).toContainText("biology meets intelligence");
    await expect(page.locator('a.btn--primary[href="/explorer/molecules/"]')).toBeVisible();
    await expect(page.locator('a.btn--ghost[href="/chat.html"]')).toBeVisible();
  });
});
