import { expect, test } from "@playwright/test";

test.describe("molecular explorer", () => {
  test("molecules page searches and opens a profile with 3D mount", async ({ page }) => {
    await page.goto("./explorer/molecules/");
    await expect(page.locator(".page-title")).toHaveText("Molecules");

    const featured = page.locator("#featured-results .molecule-row");
    await expect(featured.first()).toBeVisible({ timeout: 30_000 });

    await page.goto("./explorer/molecules/profile.html?cid=2519");
    await expect(page.locator(".page-title")).toContainText(/Caffeine|CID 2519/i, {
      timeout: 45_000,
    });
    await expect(page.locator("#profile-viewer")).toBeVisible();
    await expect(page.locator('a.btn--primary[href*="chat.html"]')).toBeVisible();
  });
});
