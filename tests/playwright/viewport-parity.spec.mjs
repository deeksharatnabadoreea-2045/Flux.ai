import { expect, test } from "@playwright/test";

const SHARED = {
  title: /Flux — human body/,
  stamp: "prod-2026-11-22-restore-703b883-frontend",
  cacheBust: "restore-703b883-frontend-1",
};

test.describe("one Flux site — same content at 375, 768, and 1440", () => {
  test("loads the same build and keeps all sections", async ({ page }, testInfo) => {
    const width = page.viewportSize()?.width ?? 0;

    await page.goto("./index.html");

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

    const isMobile = width <= 900;
    const deployRelease = page.locator("#flux-deploy-release");
    await expect(deployRelease).toBeAttached();
    await expect(deployRelease).toHaveText(SHARED.stamp);
    if (!isMobile) {
      await expect(deployRelease).toBeVisible();
      await expect(page.locator(".landing-footer .brand-mark")).toBeVisible();
      await expect(page.locator(".landing-footer .brand-mark")).toHaveText("Flux");
    }

    const newChat = page.locator(".nav-item", { hasText: "New Chat" });
    const chats = page.locator("#chat-list-toggle");
    const sidebarToggle = page.locator("#sidebar-toggle");

    await page.screenshot({
      path: `/opt/cursor/artifacts/layout-${width}.png`,
      fullPage: false,
    });

    if (isMobile) {
      await expect(sidebarToggle).toBeVisible();
      await expect(newChat).not.toBeInViewport();
      await expect(chats).not.toBeInViewport();
    } else {
      await expect(sidebarToggle).toBeHidden();
      await expect(newChat).toBeVisible();
      await expect(chats).toBeVisible();
    }

    await expect(page.locator(".brand").first()).toHaveText("Flux");

    const projectWidth = { mobile: 375, tablet: 768, desktop: 1440 }[testInfo.project.name];
    expect(width).toBe(projectWidth);
  });
});