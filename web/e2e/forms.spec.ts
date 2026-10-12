import { test, expect, ACTIVE, BREACHED } from "./fixtures";

// Exponent-notation inputs (1e30, 1e-7) used to reach viem parseUnits during render and blank the page
// ("Application error"). The guard fixture fails the test on any pageerror.

test("follow form rejects huge, tiny and out-of-range values without crashing", async ({ page }) => {
  await page.goto(`/follow/${ACTIVE}`);
  const cases: [string, string, RegExp][] = [
    ["#f-notional", "1e30", /too large/i],
    ["#f-notional", "0.0000001", /at least 1 AUSD/i],
    ["#f-ratio", "0.0000001", /at least 0\.01%/i],
    ["#f-chase", "1e30", /0 to 10,000 bps/i],
    ["#f-band", "99999999999", /1 to 10,000 bps/i],
  ];
  for (const [id, v, msg] of cases) {
    await page.locator(id).fill(v);
    await expect(page.locator(`${id}-err`)).toHaveText(msg);
    await expect(page.locator(id)).toHaveAttribute("aria-invalid", "true");
    await page.locator(id).fill(id === "#f-ratio" ? "2" : id === "#f-notional" ? "300" : "50");
    await expect(page.locator(`${id}-err`)).toHaveCount(0);
  }
  // over the registry cap: one message, not the hint and the error saying the same thing
  await page.locator("#f-deposit").fill("1e30");
  await expect(page.getByText(/caps each vault at/)).toHaveCount(1);
});

test("become-leader validates the mandate against LeaderBook bounds without crashing", async ({ page }) => {
  await page.goto("/become-leader");
  const inputs = page.locator("main input[type=number]");
  const n = await inputs.count();
  expect(n).toBeGreaterThanOrEqual(6);
  for (let i = 0; i < n; i++) {
    for (const v of ["1e30", "-5"]) {
      await inputs.nth(i).fill(v);
      await expect(inputs.nth(i)).toHaveAttribute("aria-invalid", "true");
    }
  }
  // dd, leverage, epoch hours, capital: 1e-7 used to throw "not a valid decimal number" / BigInt errors in render
  for (const i of [0, 1, 3, 4]) {
    await inputs.nth(i).fill("1e-7");
    await expect(inputs.nth(i)).toHaveAttribute("aria-invalid", "true");
  }
  await expect(page.getByRole("button", { name: /Open LeaderBook/ })).toBeDisabled();
  await expect(page.locator("main")).not.toContainText(/1e\+30|1e-7|-5x|−\$/);
});

test("landing counts the slashed leader even though a slash leaves it Unbonded", async ({ page }) => {
  await page.goto("/");
  // BREACHED was slashed in epoch 2 (indexer Breach row) and now reads status Unbonded onchain
  const slashed = page.getByText(/leaders? slashed so far/i).locator("xpath=preceding-sibling::p[1]");
  await expect(slashed).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByText("AUSD leader bonds")).toBeVisible();
  await expect(page.getByText(/at stake now \(bonds \+ underwriters\)/i)).toBeVisible();
});

test("attested track record shows cents and a singular trade; no empty smart-money chip", async ({ page }) => {
  await page.goto(`/leader/${BREACHED}`);
  await expect(page.getByText(/PnL 30d [−+]?\$\d+\.\d{2} · WR \d+% · 1 trade$/)).toBeVisible();
  await expect(page.getByText(/smart-money data unavailable/i)).toHaveCount(0);
});
