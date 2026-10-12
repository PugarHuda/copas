import { test, expect, gotoUntil, ACTIVE } from "./fixtures";

// Live quotes from the hosted onramp: either a real quote renders or the provider's own error does. Never NaN.
for (const [source, provider] of [
  ["USDC on Base", /Aurora 1Click|Socket/],
  ["USDT on BNB Chain", /Aurora 1Click|Socket/],
  ["MON on Monad", /Kuru Flow/],
] as const) {
  test(`fund from any chain: ${source}`, async ({ page, guard }) => {
    // a provider that cannot route answers 4xx/5xx through the proxy; the panel shows that message (asserted below)
    guard.allow(/http [45]\d\d: .*\/api\/onramp\//, /status of [45]\d\d/);
    await gotoUntil(page, `/follow/${ACTIVE}`, (p) => p.getByLabel("From"));
    await page.getByLabel("From").selectOption({ label: source });
    await page.getByLabel(/^Amount/).fill("10");
    await page.getByRole("button", { name: "Get quote" }).click();
    const out = page.getByTestId("fund-result");
    await expect(out.getByText("You receive").or(out.getByText("No provider can route this right now"))).toBeVisible({ timeout: 80_000 });
    const text = await out.innerText();
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    if (/You receive/.test(text)) {
      await expect(out.locator("dd").first()).toHaveText(provider);
      await expect(out.locator("div", { hasText: /^You receive/ }).locator("dd")).toHaveText(/^\d[\d,.]* (USDC|AUSD)$/);
      await expect(out.getByText("Sign in with your passkey to get a deposit address")).toBeVisible();
    }
  });
}
