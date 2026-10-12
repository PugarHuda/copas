import { test, expect, checkPage, noOverflow, gotoUntil, STATUS_LABEL, ACTIVE, BREACHED } from "./fixtures";
import { readBook } from "./chain";

test.describe("landing /", () => {
  test.beforeEach(async ({ page }) => {
    await gotoUntil(page, "/", (p) => p.getByRole("link", { name: "0xda69…3D90" }));
  });

  test("hero renders a WebGL canvas and the wordmark", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1, name: "copas" })).toBeVisible();
    // the three.js renderer canvas is prepended client-side; wait for it, then check it is sized and WebGL
    await expect.poll(() => page.locator("section canvas").count()).toBeGreaterThanOrEqual(2);
    const gl = await page.locator("section canvas").evaluateAll((cs) =>
      (cs as HTMLCanvasElement[]).map((c) => ({ w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height, webgl: !!(c.getContext("webgl2") || c.getContext("webgl")) })).filter((c) => c.webgl),
    );
    expect(gl.length).toBeGreaterThanOrEqual(1);
    expect(gl[0].w).toBeGreaterThan(0);
    expect(gl[0].h).toBeGreaterThan(0);
  });

  test("How it works shows live numbers", async ({ page }) => {
    const how = page.locator("section", { has: page.getByRole("heading", { name: "How it works" }) });
    const stats = how.locator("li p.num");
    await expect(stats).toHaveCount(3);
    for (const s of await stats.allInnerTexts()) expect(s.trim()).toMatch(/^\d[\d,.]*( AUSD)?$/);
  });

  test("leaderboard lists the active and the breached leader", async ({ page }) => {
    const rows = page.locator("#leaders ~ div li");
    const active = rows.filter({ has: page.getByRole("link", { name: "0xda69…3D90" }) });
    const breached = rows.filter({ has: page.getByRole("link", { name: "0xb1B0…5208" }) });
    await expect(active).toContainText("Active");
    // breached in epoch 2; with no bond left the contract later reports it Unbonded
    const status = (await readBook(BREACHED)).status;
    expect(["breached", "unbonded"]).toContain(status);
    await expect(breached).toContainText(STATUS_LABEL[status]);
    await expect(active.getByRole("link", { name: "Follow" })).toHaveAttribute("href", `/follow/${ACTIVE}`);
    const follow = breached.getByRole("button", { name: "Follow" });
    await expect(follow).toBeDisabled();
    await expect(breached.getByRole("link", { name: "0xb1B0…5208" })).toHaveAttribute("href", `/leader/${BREACHED}`);
  });

  test("global checks and no horizontal overflow", async ({ page }) => {
    await expect(page.getByText("0xda69…3D90").first()).toBeVisible();
    await checkPage(page);
    await noOverflow(page);
  });
});
