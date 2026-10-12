import { test, expect, checkPage, noOverflow, gotoUntil, parseNum, STATUS_LABEL, ACTIVE, BREACHED, VAULT } from "./fixtures";
import { readBook } from "./chain";


test("/me signed out asks for a passkey", async ({ page }) => {
  await page.goto("/me");
  await expect(page.getByRole("heading", { level: 1, name: /my vault/i })).toBeVisible();
  await expect(page.getByText("Sign in with your passkey to see your vault.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pick a leader to follow" })).toBeVisible();
  await checkPage(page);
  await noOverflow(page);
});

test("/me?vault= shows vault data read-only for a non-owner", async ({ page }) => {
  await gotoUntil(page, `/me?vault=${VAULT}`, (p) => p.getByText(/Vault 0x38e8…74ff following 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/));
  const equity = page.getByText("Equity", { exact: true }).locator("..");
  await expect(equity).toContainText(/\$\d[\d,]*\.\d{2}/);
  await expect(page.getByText("Execution proof per copy")).toBeVisible();
  // write actions are owner-only
  await expect(page.getByLabel("Amount (AUSD)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Withdraw to my address" })).toBeDisabled();
  for (const claim of await page.getByRole("button", { name: "Claim to vault" }).all()) await expect(claim).toBeDisabled();
  await expect(page.getByText(/Only the vault owner \(0x[0-9a-f]{4}…[0-9a-f]{4}\) can withdraw or claim\./)).toBeVisible();
  await checkPage(page);
  await noOverflow(page);
});

test("/underwrite lists every leader's pool", async ({ page }) => {
  await gotoUntil(page, "/underwrite", (p) => p.locator("table tbody tr", { hasText: "0xda69…3D90" }));
  const table = page.locator("table").filter({ hasText: "Underwriter pool" });
  await expect(table.locator("thead")).toContainText("Leader bond (first loss)");
  const active = table.locator("tbody tr", { hasText: "0xda69…3D90" });
  const breached = table.locator("tbody tr", { hasText: "0xb1B0…5208" });
  await expect(active).toContainText("Active");
  await expect(breached).toContainText(STATUS_LABEL[(await readBook(BREACHED)).status]);
  await expect(active).toContainText(/\$\d[\d,]*\.\d{2}/);
  await checkPage(page);
  await noOverflow(page);
});

test.describe("/proof", () => {
  test.beforeEach(async ({ page }) => {
    // the worked example needs a getLogs read on the public RPC
    await gotoUntil(page, "/proof", (p) => p.getByRole("button", { name: "Reset to breach data" }));
  });

  test("breach math, slash row and Privy DENY log are real", async ({ page }) => {
    const breaches = page.locator("table").filter({ hasText: "Peak → unit" });
    const row = breaches.locator("tbody tr", { hasText: "0xb1B0…5208" });
    await expect(row).toContainText("DRAWDOWN");
    await expect(row).toContainText(/\$\d[\d,]*\.\d{2}/);
    // breach ⇔ dd > maxDD, with the numbers spelled out
    const math = page.getByText(/breach ⇔ dd > maxDD \(0xb1B0…5208: 1 − ([\d.]+) \/ ([\d.]+) = ([\d.]+)% > ([\d.]+)%\)/);
    await expect(math).toBeVisible();
    const [, u, peak, dd, max] = (await math.innerText()).match(/1 − ([\d.]+) \/ ([\d.]+) = ([\d.]+)% > ([\d.]+)%/)!.map(Number);
    expect(Math.abs((1 - u / peak) * 100 - dd)).toBeLessThan(0.001);
    expect(dd).toBeGreaterThan(max);
    await expect(page.locator("tr", { hasText: "policy_violation" }).first()).toBeVisible();
    await checkPage(page);
    await noOverflow(page);
  });

  test("Recompute reads a testnet LeaderBook live", async ({ page }) => {
    const box = page.locator("div").filter({ has: page.getByRole("heading", { name: "Recompute" }) }).filter({ has: page.getByRole("button", { name: "Read equity" }) }).last();
    await expect(box.locator("dd").nth(2)).toHaveText("breach"); // prefilled from the breach above
    await box.getByLabel("LeaderBook, Perpl address or account ID").fill(ACTIVE);
    // the read goes to the public RPC; on "did not respond. Try again." do what the message says
    await expect(async () => {
      await box.getByRole("button", { name: "Read equity" }).click();
      await expect(box.getByRole("status")).toHaveText(/LeaderBook on Monad Testnet: unit price \d\.\d{6}, peak \d\.\d{6}\./, { timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    expect(parseNum(await box.locator("dd").first().innerText())).toBeGreaterThan(0);

    await box.getByLabel("LeaderBook, Perpl address or account ID").fill("not-an-address");
    await box.getByRole("button", { name: "Read equity" }).click();
    await expect(box.getByRole("status")).toHaveText("Enter a 0x… address or Perpl account ID.");
  });
});

test("/market shows the Kuru top of book", async ({ page }) => {
  await gotoUntil(page, `/market/${ACTIVE}`, (p) => p.getByText(/DOWN · 0xda69…3d90 · epoch \d+/i));
  const book = page.locator("table").filter({ hasText: "Price (AUSD)" });
  await expect(book.locator("tbody tr").first()).toBeVisible();
  // The UP/DOWN series is per epoch; the epoch-2 book on Kuru was 0.05 / 0.12. A newer epoch may have no series yet.
  if (await book.getByText("Best ask").count()) {
    const ask = parseNum(await book.locator("tr", { hasText: "Best ask" }).locator("td").last().innerText());
    const bid = parseNum(await book.locator("tr", { hasText: "Best bid" }).locator("td").last().innerText());
    if (await page.getByText(/· epoch 2$/i).count()) [bid, ask].forEach((v, i) => expect(v).toBe([0.05, 0.12][i]));
    expect(bid).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(bid);
    expect(ask).toBeLessThan(1);
    await expect(page.getByText("Breach odds (DOWN price)").locator("..")).toContainText(/\d+%/);
  } else {
    await expect(book).toContainText(/No UP\/DOWN series minted for this epoch yet\.|No Kuru orders yet\./);
  }
  await checkPage(page);
  await noOverflow(page);
});

test("/market for a breached leader also renders", async ({ page }) => {
  await page.goto(`/market/${BREACHED}`);
  await expect(page.getByText(/DOWN · 0xb1b0…5208 · epoch \d+/i)).toBeVisible();
  await checkPage(page);
});

test("/saved: losers share is a number and capital recalculates", async ({ page }) => {
  await page.goto("/saved");
  const losers = page.getByText("Traders who lost money", { exact: true }).locator("..");
  await expect(losers).toContainText(/\d+%/);
  const share = parseNum((await losers.innerText()).match(/(\d+)%/)![0]);
  expect(share).toBeGreaterThan(0);
  expect(share).toBeLessThanOrEqual(100);
  await expect(losers).toContainText(/\d[\d,]* of \d[\d,]* with non-zero PnL/);

  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible();
  const before = await rows.first().locator("td").nth(3).innerText();
  await page.getByLabel("Capital you copy with (AUSD)").fill("5000");
  await page.getByRole("button", { name: /recalculate/i }).click();
  await expect(page).toHaveURL(/c=5000/);
  await expect(page.getByText("your capital: $5,000")).toBeVisible();
  await expect(rows.first().locator("td").nth(3)).not.toHaveText(before);
  for (const r of await rows.all()) {
    const text = await r.locator("td").allInnerTexts();
    expect(text[2], "ROI uses the same minus sign as every other figure").toMatch(/^(−\d|\d)/);
    const cells = text.map(parseNum);
    expect(cells[3]).toBeLessThanOrEqual(0);
    expect(cells[5]).toBeCloseTo(cells[3] + cells[4], 1); // net = loss + returned
  }
  await checkPage(page);
  await noOverflow(page);
});

test("/analytics and a top trader's wallet page", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("24h volume", { exact: true }).first()).toBeVisible();
  const top = page.locator("table").filter({ hasText: "PnL 30d" });
  const first = top.locator("tbody tr").first().getByRole("link");
  await expect(first).toBeVisible();
  // full-history counters must not be stuck at the 1000-row page cap
  const liq = page.getByText(/^Liquidations, /).locator("..");
  await expect(liq).toBeVisible();
  expect((await liq.innerText()).split("\n")[0].trim()).not.toBe("1,000");
  for (const s of await page.locator(".num").allInnerTexts()) expect(s.trim()).not.toBe("1,000");
  await checkPage(page);
  await noOverflow(page);

  const href = (await first.getAttribute("href"))!;
  expect(href).toMatch(/^\/analytics\/wallet\/(0x[0-9a-fA-F]{40}|\d+)$/);
  await page.goto(href);
  await expect(page.locator("h1")).toHaveText(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}|#\d+/);
  for (const s of await page.locator(".num").allInnerTexts()) expect(s.trim()).not.toBe("1,000");
  await checkPage(page);
  await noOverflow(page);
});

test("/analytics/compare explains how to pick wallets", async ({ page }) => {
  await page.goto("/analytics/compare");
  await expect(page.getByText(/Pick 2 to 3 wallets/)).toBeVisible();
  await checkPage(page);
});

test("/become-leader mandate tiers and seal", async ({ page }) => {
  await page.goto("/become-leader");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/become a leader/i);
  for (const tier of ["Conservative", "Moderate", "Aggressive"]) await expect(page.getByText(tier, { exact: true })).toBeVisible();
  await page.getByText("Conservative", { exact: true }).click();
  await expect(page.getByLabel("Max drawdown per epoch (%)")).toHaveValue("5");
  await expect(page.getByLabel("Max leverage")).toHaveValue("3");
  await expect(page.getByText("Capacity = min(3 × equity, 20 × bond).")).toBeVisible();
  await checkPage(page);
  await noOverflow(page);
});

test("/settings signed out", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("signed out", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create passkey account" })).toBeVisible();
  await checkPage(page);
  await noOverflow(page);
});
