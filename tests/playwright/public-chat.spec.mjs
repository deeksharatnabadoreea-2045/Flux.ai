import { expect, test } from "@playwright/test";
import { ANON_MAX_REQUESTS } from "../../js/chat-rate-store.mjs";

test.describe("public Flux chat", () => {
  test("anonymous visitor opens site and chats without Cursor sign-in", async ({
    page,
  }, testInfo) => {
    await page.goto("./chat.html");
    await expect(page.locator(".brand").first()).toContainText("Flux");
    await expect(page.locator("#composer-input")).toBeVisible();

    // No Cursor gate chrome on local public HQ.
    await expect(page.getByText("Open this app")).toHaveCount(0);
    await expect(page.getByText("Log into your Grok Bot account")).toHaveCount(0);

    await page.locator("#composer-input").fill("What is glucose?");
    await page.locator("#composer-form").evaluate((form) => form.requestSubmit());

    const assistant = page.locator(".chat-bubble-assistant .chat-bubble-body").first();
    await expect(assistant).toBeVisible({ timeout: 60_000 });
    const text = await assistant.innerText();
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toMatch(/gsk_|GROQ_API_KEY|sign_in_required|Open this app/i);

    // Follow-up in the same thread.
    await page.locator("#composer-input").fill("What is its formula?");
    await page.locator("#composer-form").evaluate((form) => form.requestSubmit());
    await expect(page.locator(".chat-bubble-assistant .chat-bubble-body")).toHaveCount(2, {
      timeout: 60_000,
    });

    // Capture evidence for desktop vs mobile projects.
    await page.screenshot({
      path: `/opt/cursor/artifacts/public-chat-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("API rejects cross-origin and rate-limits abusive anonymous clients", async ({
    request,
    baseURL,
  }) => {
    const blocked = await request.post(`${baseURL}/api/chat`, {
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      data: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(blocked.status()).toBe(403);
    expect((await blocked.json()).error).toBe("origin_forbidden");

    const abuseIp = `203.0.113.${50 + Math.floor(Math.random() * 50)}`;
    let cookie = "";
    let saw429 = false;
    for (let i = 0; i < ANON_MAX_REQUESTS + 8; i += 1) {
      const headers = {
        origin: baseURL,
        "content-type": "application/json",
        // Cursor Apps trusts x-vercel-forwarded-for; plain XFF is ignored locally → 503.
        "x-vercel-forwarded-for": abuseIp,
      };
      if (cookie) headers.cookie = cookie;
      const res = await request.post(`${baseURL}/api/chat`, {
        headers,
        data: { messages: [{ role: "user", content: `ping ${i}` }] },
      });
      const setCookie = res.headers()["set-cookie"];
      if (setCookie && !cookie) {
        cookie = String(setCookie).split(";")[0];
      }
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/gsk_|GROQ_API_KEY/);
      if (res.status() === 429) {
        saw429 = true;
        expect(body.error).toBe("rate_limited");
        break;
      }
      expect(res.ok()).toBeTruthy();
    }
    expect(saw429).toBeTruthy();
  });

  test("health endpoint is public and does not leak secrets", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/chat`, {
      headers: { origin: baseURL },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.publicChat).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/gsk_|CHAT_SESSION_SECRET|sk-/);
  });
});
