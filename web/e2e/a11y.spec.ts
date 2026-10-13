import AxeBuilder from "@axe-core/playwright";
import { test, expect, gotoUntil, ROUTES } from "./fixtures";

/** axe-core WCAG 2.2 AA on every route, per viewport: no serious or critical violation. */
for (const [path, ready] of ROUTES) {
  test(`a11y ${path}`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await gotoUntil(page, path, (p) => p.locator(ready));
    await expect(page.locator(".animate-pulse"), "skeleton still loading after 20 s").toHaveCount(0, { timeout: 20_000 });
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    await info.attach("axe", { body: JSON.stringify(violations, null, 2), contentType: "application/json" });
    const bad = violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 5).map((n) => n.target.join(" ")).join(" | ")}`);
    expect(bad, `${path} axe violations`).toEqual([]);
  });
}
