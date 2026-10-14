// Out-of-the-box checks against production: hostile input, abuse of public APIs, degraded browsers.
// npx playwright test e2e/edge.spec.ts --project=desktop
import { expect, test } from "@playwright/test";

const SVC = "https://copas-services.vercel.app";
const XSS = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
const LEADER = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";

test.describe("hostile URLs", () => {
  for (const path of [`/leader/${encodeURIComponent(XSS)}`, `/me?owner=${encodeURIComponent(XSS)}`, `/follow/${encodeURIComponent(XSS)}`, `/market/${encodeURIComponent(XSS)}`, `/analytics/wallet/${encodeURIComponent(XSS)}`]) {
    test(`XSS payload is never executed or reflected raw: ${path.slice(0, 40)}`, async ({ page }) => {
      let dialog = false;
      page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
      const r = await page.goto(path);
      expect(r!.status()).toBeLessThan(500);
      await page.waitForTimeout(1500);
      expect(dialog).toBe(false);
      expect(await page.content()).not.toContain("<img src=x onerror=alert(1)>");
    });
  }

  test("a valid address that is not a leader gets a clear page, not a crash", async ({ page }) => {
    const r = await page.goto("/leader/0x000000000000000000000000000000000000dEaD");
    expect(r!.status()).toBeLessThan(500);
    await expect(page.locator("body")).not.toContainText(/Application error|Internal Server Error|TypeError/);
  });

  test("absurd season week falls back instead of erroring", async ({ page }) => {
    const r = await page.goto("/seasons?w=99999999999999");
    expect(r!.status()).toBeLessThan(500);
    await expect(page.locator("body")).toContainText(/Season/);
  });
});

test.describe("public API abuse", () => {
  test("Dynamic guard: bad address 400, no delegation 404, nothing signed", async ({ request }) => {
    expect((await request.post("/api/dynamic/guard", { data: { address: "nope" } })).status()).toBe(400);
    expect((await request.post("/api/dynamic/guard", { data: { address: "0x000000000000000000000000000000000000dEaD", probe: "withdraw" } })).status()).toBe(404);
  });

  test("Dynamic webhook refuses unsigned / forged deliveries", async ({ request }) => {
    const r = await request.post("/api/dynamic/webhook", { data: { eventName: "wallet.delegation.created", data: {} } });
    expect([401, 503]).toContain(r.status());
  });

  test("Alchemy webhook refuses a forged signature", async ({ request }) => {
    const r = await request.post("/api/alchemy", { data: { type: "ADDRESS_ACTIVITY" }, headers: { "x-alchemy-signature": "00".repeat(32) } });
    expect(r.status()).toBe(401);
  });

  test("services proxy only forwards allow-listed paths", async ({ request }) => {
    // discover (GET) and simulate (POST) are allow-listed on purpose; these are not
    for (const p of ["../../etc/passwd", "mcp", "x402/report/" + LEADER, `leader/${LEADER}/backtest`, `leader/${LEADER}/../../x402/report/${LEADER}`]) {
      expect((await request.get(`/api/services/${p}`)).status(), p).toBeGreaterThanOrEqual(400);
    }
  });

  test("services: malformed leader address is a 4xx, never a 500", async ({ request }) => {
    const r = await request.get(`${SVC}/leader/not-an-address/stats`);
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
  });

  test("x402 report without payment answers 402 Payment Required", async ({ request }) => {
    const r = await request.get(`${SVC}/x402/report/${LEADER}`);
    expect(r.status()).toBe(402);
  });

  test("MCP: unknown tool returns a JSON-RPC error, not a crash", async ({ request }) => {
    const r = await request.post(`${SVC}/mcp`, {
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drop_tables", arguments: {} } },
    });
    expect(r.status()).toBeLessThan(500);
    expect(await r.text()).toMatch(/error|not found|unknown/i);
  });
});

test.describe("degraded browsers", () => {
  test("JavaScript disabled: the leaderboard still renders server-side", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("body")).toContainText(/bond/i);
    await ctx.close();
  });

  test("320px phone: no horizontal scroll on home, leader and trade", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await ctx.newPage();
    for (const p of ["/", `/leader/${LEADER}`, "/trade"]) {
      await page.goto(p);
      await page.waitForTimeout(1500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, p).toBeLessThanOrEqual(1);
    }
    await ctx.close();
  });

  test("going offline on /trade shows a message instead of a dead page", async ({ page, context }) => {
    await page.goto("/trade");
    await page.waitForTimeout(3000); // let the service worker install
    await context.setOffline(true);
    await page.reload().catch(() => undefined);
    await expect(page.locator("body")).toContainText(/offline|connection|network/i);
    await context.setOffline(false);
  });

  test("security headers are set", async ({ request }) => {
    const h = (await request.get("/")).headers();
    expect(h["x-frame-options"] ?? h["content-security-policy"] ?? "").not.toBe("");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });
});
