import { test, expect, checkPage, noOverflow, gotoUntil, ACTIVE, BREACHED } from "./fixtures";
import { readBook } from "./chain";

test.describe("follow an active leader", () => {
  test.beforeEach(async ({ page }) => {
    await gotoUntil(page, `/follow/${ACTIVE}`, (p) => p.getByLabel("Deposit (AUSD)"));
  });

  const summary = (page: import("@playwright/test").Page) => page.locator("dl").filter({ hasText: "Max protection after you join" });

  async function expectSaneSummary(page: import("@playwright/test").Page) {
    const s = await summary(page).innerText();
    expect(s).not.toMatch(/NaN|Infinity|undefined/);
    expect(s).not.toMatch(/[−-]\$|[−-]\d/); // nothing negative
  }

  test("negative deposit shows an inline error", async ({ page }) => {
    const dep = page.getByLabel("Deposit (AUSD)");
    await dep.fill("-5");
    await expect(dep).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#f-deposit-err")).toHaveText(/Enter at least \d+ AUSD: the first deposit opens/);
    await expect(summary(page).locator("div", { hasText: /^Deposit/ }).locator("dd")).toHaveText("–");
    await expectSaneSummary(page);
  });

  test("empty ratio shows an inline error", async ({ page }) => {
    const ratio = page.getByLabel("Copy ratio (% of leader size)");
    await ratio.fill("");
    await expect(ratio).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#f-ratio-err")).toHaveText("Enter a ratio of at least 0.01% (1 bps).");
    await expect(summary(page).locator("div", { hasText: /^Ratio/ }).locator("dd")).toHaveText("–");
    await expectSaneSummary(page);
  });

  test("leverage above the mandate shows an inline error", async ({ page }) => {
    const { maxLeverage } = await readBook(ACTIVE);
    const lev = page.getByLabel("Max leverage");
    await lev.fill(String(maxLeverage + 1));
    await expect(lev).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#f-lev-err")).toHaveText(`The leader's mandate allows at most ${maxLeverage}x.`);
    await expect(summary(page).locator("div", { hasText: /^Max leverage/ }).locator("dd")).toHaveText("–");
    await expectSaneSummary(page);
  });

  test("valid defaults have no errors and a sane summary", async ({ page }) => {
    await expect(page.locator("[aria-invalid=true]")).toHaveCount(0);
    await expect(summary(page)).toContainText("Deposit");
    await expectSaneSummary(page);
    await expect(page.getByText("Sign in with your passkey to create a vault and follow.")).toBeVisible();
    await checkPage(page);
    await noOverflow(page);
  });
});

test("breached leader explains why and shows no form", async ({ page }) => {
  const { status } = await readBook(BREACHED);
  await gotoUntil(page, `/follow/${BREACHED}`, (p) => p.getByText("This leader can't be followed"));
  // breached in epoch 2; with no bond left the contract later reports it Unbonded
  await expect(
    page.getByText(
      status === "breached"
        ? /broke its mandate in epoch \d+: the bond was slashed and paid to followers\. A breached LeaderBook takes no new followers\./
        : /has withdrawn or is withdrawing its bond, so nothing is at stake to protect a new follower\./,
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Deposit (AUSD)")).toHaveCount(0);
  await expect(page.locator("main input")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "See profile and checkpoints" })).toHaveAttribute("href", `/leader/${BREACHED}`);
  await checkPage(page);
  await noOverflow(page);
});
