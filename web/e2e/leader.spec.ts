import { test, expect, checkPage, noOverflow, gotoUntil, panel, STATUS_LABEL, ACTIVE, BREACHED } from "./fixtures";
import { readBook } from "./chain";

const usd0 = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pctAuto = (v: number) => `${v >= 10 ? Math.round(v) : Number(v.toPrecision(2))}%`;

// BREACHED broke its mandate in epoch 2; once the epoch rolls with no bond left the contract reports it Unbonded.
for (const [label, book] of [
  ["active", ACTIVE],
  ["breached", BREACHED],
] as const) {
  test.describe(`leader page (${label})`, () => {
    test("status, bond and mandate match chain", async ({ page }) => {
      const chain = await readBook(book);
      if (label === "active") expect(chain.status).toBe("active");
      else expect(["breached", "unbonded"]).toContain(chain.status);
      await gotoUntil(page, `/leader/${book}`, (p) => p.getByText(`LeaderBook ${book}`));
      await expect(page.locator("h1").locator("..")).toContainText(STATUS_LABEL[chain.status]);
      await expect(page.getByText(`LeaderBook ${book}`)).toBeVisible();
      await expect(page.getByText(chain.status === "breached" ? `Bond left: ${usd0(chain.bond)}.` : `stakes ${usd0(chain.bond)} of their own`)).toBeVisible();

      const mandate = panel(page, "Mandate");
      const promise = (name: string) => mandate.locator("li", { hasText: name }).locator("span.num").first();
      await expect(promise("Max drawdown per epoch")).toHaveText(pctAuto(chain.maxDD));
      await expect(promise("Max leverage")).toHaveText(`${chain.maxLeverage}x`);
      await expect(promise("Max notional")).toHaveText(usd0(chain.maxNotional));
      await expect(mandate).toContainText(`${chain.feePct}% performance fee`);

      if (chain.status === "active") await expect(page.getByRole("link", { name: "Follow this leader" })).toHaveAttribute("href", `/follow/${book}`);
      else await expect(page.getByRole("button", { name: "Follow this leader" })).toBeDisabled();
    });

    test("positions and checkpoints panels have real rows", async ({ page }) => {
      await gotoUntil(page, `/leader/${book}`, (p) => panel(p, "Leader positions").locator("tbody tr").or(panel(p, "Leader positions").getByText("No open positions.")));
      const positions = panel(page, "Leader positions");
      await expect(positions.locator("tbody tr").or(positions.getByText("No open positions.")).first()).toBeVisible();
      for (const r of await positions.locator("tbody tr").all()) await expect(r.locator("td").first()).toHaveText(/^(BTC|ETH|SOL|MON)$/);

      const cps = panel(page, "Checkpoints and breaches");
      const rows = cps.locator("tbody tr");
      await expect(rows.first()).toBeVisible();
      for (const r of (await rows.all()).slice(0, 5)) {
        await expect(r.locator("td").nth(2)).toHaveText(/^\d\.\d{4}$/); // unit price
        await expect(r.locator("td").nth(3)).toHaveText(/^\d+\.\d{2}%$/); // drawdown
      }
      if (label === "breached") await expect(cps).toContainText("Breach: DRAWDOWN");
      await checkPage(page);
      await noOverflow(page);
    });

    test("OG image is a PNG", async ({ request }) => {
      const res = await request.get(`/leader/${book}/opengraph-image`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
      const body = await res.body();
      expect(body.subarray(1, 4).toString()).toBe("PNG");
      expect(body.length).toBeGreaterThan(1000);
    });
  });
}
