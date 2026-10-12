import { test, expect, checkPage } from "./fixtures";

for (const path of ["/leader/0xdeadbeef", "/follow/0xdeadbeef", "/market/0xdeadbeef", "/analytics/wallet/not-a-wallet", "/no-such-page"]) {
  test(`${path} is a 404 with the not-found page`, async ({ page, guard }) => {
    guard.allow(/404/); // the document itself, and Chrome's matching console line
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "See leaders" })).toHaveAttribute("href", "/#leaders");
    await checkPage(page);
  });
}

test.describe("API guards", () => {
  test.skip(({ isMobile }) => isMobile, "API checks are viewport-independent");
  // never send a valid address to /api/faucet here: it spends testnet funds
  for (const [name, body] of [
    ["empty object", "{}"],
    ["not JSON", "nope"],
    ["short address", '{"address":"0x123"}'],
    ["numeric address", '{"address":12}'],
  ] as const) {
    test(`faucet rejects ${name}`, async ({ request }) => {
      const res = await request.post("/api/faucet", { data: body, headers: { "content-type": "application/json" } });
      expect(res.status()).toBe(400);
      expect(await res.json()).toEqual({ error: "bad-address" });
    });
  }

  test("services proxy refuses paths outside its allowlist", async ({ request }) => {
    for (const p of ["/api/services/admin", "/api/services/leader/0x1/stats", "/api/services/discover/../secret"]) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(404);
    }
    expect((await request.post("/api/services/discover")).status()).toBe(404); // wrong method
  });

  test("perpl proxy refuses paths outside its allowlist", async ({ request }) => {
    for (const p of ["/api/perpl/v1/account/1", "/api/perpl/v1/trading/leaderboard/year/pnl", "/api/perpl/v2/pub/context"]) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(404);
      expect(await res.json()).toEqual({ error: "path not allowed" });
    }
  });
});
