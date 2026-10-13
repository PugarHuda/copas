import { test as base, expect, type Locator, type Page } from "@playwright/test";

export const ACTIVE = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";
export const BREACHED = "0xb1B08F6a0642c51b48c1916136458A769a1c5208";
export const VAULT = "0x38E8EbBD7Bd291036A0EFe4a6eFa3BCcd27D74ff";

/** Every route with the selector that means "rendered" (crawl + a11y specs). */
export const ROUTES: [string, string][] = [
  ["/", "h1"],
  [`/leader/${ACTIVE}`, "h1"],
  [`/leader/${BREACHED}`, "h1"],
  [`/follow/${ACTIVE}`, "h1"],
  [`/follow/${BREACHED}`, "h1"],
  [`/market/${ACTIVE}`, "h1"],
  ["/me", "h1"],
  [`/me?vault=${VAULT}`, "h1"],
  ["/saved", "h1"],
  ["/seasons", "h1"],
  ["/proof", "h1"],
  ["/become-leader", "h1"],
  ["/underwrite", "h1"],
  ["/analytics", "h1"],
  ["/analytics/compare", "h1"],
  ["/settings", "h1"],
];

/** Text that must never reach a user. */
const FORBIDDEN = [/\bNaN\b/, /\bundefined\b/, /\bInfinity\b/, /\bmock\b/i, /demo data/i, /coming soon/i, /\bTODO\b/, /\bKimi\b/i, /lorem/i, /[−+-]\$0(?:\.0+)?(?![.,]?\d)/ /* signed zero money: "−$0" */];

type Guard = {
  /** Console errors / same-origin >=400 responses matching these are expected for this test. */
  allow: (...re: RegExp[]) => void;
};

/**
 * Every test gets a page that records console errors, uncaught exceptions and failed same-origin
 * requests; the test fails at teardown if any were not explicitly allowed.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, baseURL }, use) => {
      // The services backtest answers 422 "not enough closed trades" for a thin leader; the UI shows that as a message.
      const allowed: RegExp[] = [/http 422: .*\/api\/services\/leader\/0x[0-9a-fA-F]{40}\/backtest$/, /status of 422/];
      const problems: string[] = [];
      const origin = new URL(baseURL!).origin;
      page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      page.on("response", (r) => {
        if (r.status() >= 400 && r.url().startsWith(origin)) problems.push(`http ${r.status()}: ${r.url()}`);
      });
      await use({ allow: (...re) => allowed.push(...re) });
      const left = problems.filter((p) => !allowed.some((re) => re.test(p)));
      expect(left, "console errors / failed same-origin requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Global content checks: forbidden text, img alt, accessible button names, single h1. */
export async function checkPage(page: Page) {
  const text = await page.locator("body").innerText();
  for (const re of FORBIDDEN) {
    const m = re.exec(text);
    expect(m && text.slice(Math.max(0, m.index - 60), m.index + 40), `${page.url()} shows ${re}`).toBeNull();
  }
  expect(await page.locator("img:not([alt])").count(), "images without alt").toBe(0);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, [role=button]")]
      .filter((b) => {
        const lb = b.getAttribute("aria-labelledby");
        const name =
          b.getAttribute("aria-label") ||
          (lb && document.getElementById(lb)?.textContent) ||
          b.textContent ||
          b.getAttribute("title") ||
          b.querySelector("img[alt], svg title")?.textContent ||
          b.querySelector("img")?.getAttribute("alt");
        return !name?.trim();
      })
      .map((b) => b.outerHTML.slice(0, 120)),
  );
  expect(unnamed, "buttons without an accessible name").toEqual([]);
  await expect(page.locator("h1")).toHaveCount(1);
}

/** No horizontal page scroll. */
export async function noOverflow(page: Page) {
  const [sw, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, "horizontal overflow").toBeLessThanOrEqual(vw);
}

/** Parse "$1,234.50" / "−$3" / "12%" into a number. */
export const parseNum = (s: string) => Number(s.replace(/[−–]/g, "-").replace(/[^0-9.-]/g, ""));

/** A <Panel> (components/ui) by its h2 title. */
export const panel = (page: Page, title: string | RegExp) => page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

/** Status pill text for a chain status. */
export const STATUS_LABEL = { active: "Active", unbonded: "Unbonded", breached: "Breached", closed: "Closed" } as const;

/**
 * Server pages read the public Monad testnet RPC, which rate-limits now and then; the app then renders an honest
 * "did not respond, try again" state. Reload (as a user would) until `ready` shows.
 */
export async function gotoUntil(page: Page, url: string, ready: (p: Page) => Locator | Locator[]) {
  await expect(async () => {
    await page.goto(url);
    for (const l of [ready(page)].flat()) await expect(l.first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 75_000 });
}
