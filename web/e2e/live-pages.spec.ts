import { test, expect, checkPage, noOverflow, gotoUntil, parseNum, ACTIVE } from "./fixtures";

/** "–" is an empty cell (no activity), anything else a signed number. */
const cell = (s: string) => (s.trim() === "–" ? 0 : parseNum(s));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const WEEK = 7 * 86_400;
const monday = (t: number) => Math.floor((t - 4 * 86_400) / WEEK) * WEEK + 4 * 86_400;
const ENVIO = "https://indexer.dev.hyperindex.xyz/042db7d/v1/graphql";
const WHALE = "0x31ca8395cf837de08b24da3f660e77761dfb974b";

test.describe("/seasons", () => {
  const badge = (p: import("@playwright/test").Page) => p.getByRole("navigation", { name: "Season" }).locator("span");
  const ready = (p: import("@playwright/test").Page) => p.locator("table.data tbody tr").or(p.getByText("No leaders existed in this season."));

  test("current season: badge dates, row math and totals", async ({ page }) => {
    await gotoUntil(page, "/seasons", ready);
    const mon = monday(Date.now() / 1000);
    await expect(badge(page)).toHaveText(new RegExp(`^Season \\d+ · ${day(mon)} – ${day(mon + WEEK - 86_400)}$`));
    // the current week has no "next" link
    await expect(page.getByRole("navigation", { name: "Season" }).getByRole("link", { name: /→$/ })).toHaveCount(0);
    await expect(page.locator("main").getByText("Ends", { exact: true }).locator("..")).toContainText(day(mon + WEEK));

    const rows = page.locator("table.data tbody tr");
    await expect(rows.first()).toBeVisible();
    let sum = 0;
    for (const r of await rows.all()) {
      const t = await r.locator("td").allInnerTexts();
      await expect(r.getByRole("link")).toHaveAttribute("href", /^\/leader\/0x[0-9a-f]{40}$/);
      // net = copy PnL + fees (shown negative) + slash received; 4-dp display rounding
      const [net, copy, fees, slash] = [t[2], t[3], t[4], t[5]].map(cell);
      expect(Math.abs(net - (copy + fees + slash)), t.join(" | ")).toBeLessThan(0.0003);
      expect(fees).toBeLessThanOrEqual(0);
      expect(slash).toBeGreaterThanOrEqual(0);
      expect(t[6]).toMatch(/^\d+ · (1 fill|\d+ fills)$/);
      expect(t[8]).toMatch(/^\d+$/);
      expect(t[9]).toMatch(/^\$\d[\d,]*$/);
      sum += net;
    }
    // ranked by followers' net, descending
    const nets = (await rows.locator("td:nth-child(3)").allInnerTexts()).map(cell);
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
    const total = cell(await page.getByText("Followers' net result", { exact: true }).locator("..").locator(".num").innerText());
    expect(Math.abs(total - sum)).toBeLessThan(0.0003 * nets.length);
    expect(cell(await page.locator("main").getByText("Leaders", { exact: true }).locator("..").locator(".num").innerText())).toBe(nets.length);
    await checkPage(page);
    await noOverflow(page);
  });

  test("slashes paid match the indexer's Claim rows of the week", async ({ page, request }) => {
    await gotoUntil(page, "/seasons", ready);
    const from = monday(Date.now() / 1000);
    const res = await request.post(ENVIO, {
      data: { query: `{ Claim(where: { chainId: { _eq: 10143 }, timestamp: { _gte: ${from}, _lt: ${from + WEEK} } }) { amountCNS } }` },
    });
    const claims: { amountCNS: string }[] = (await res.json()).data.Claim;
    const want = claims.reduce((a, c) => a + Number(c.amountCNS) / 1e6, 0);
    const shown = cell(await page.getByText("Slashes paid to followers", { exact: true }).locator("..").locator(".num").innerText());
    expect(Math.abs(shown - want)).toBeLessThan(0.0001);
  });

  for (const [name, w] of [
    ["a future week", "2031-06-02"],
    ["garbage", "garbage"],
    ["an impossible date", "2026-13-45"],
  ]) {
    test(`?w= ${name} falls back to the current season`, async ({ page }) => {
      await gotoUntil(page, `/seasons?w=${w}`, ready);
      const mon = monday(Date.now() / 1000);
      await expect(badge(page)).toHaveText(new RegExp(`^Season \\d+ · ${day(mon)} – `));
      await checkPage(page);
    });
  }

  test("a pre-season week is empty and links straight to Season 1", async ({ page }) => {
    await gotoUntil(page, "/seasons?w=2020-01-01", ready);
    await expect(badge(page)).toHaveText("Pre-season · 2019-12-30 – 2020-01-05");
    await expect(page.getByText("No leaders existed in this season.")).toBeVisible();
    await expect(page.getByText("Followers' net result", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^←/ })).toHaveCount(0);
    await page.getByRole("link", { name: "Season 1 →" }).click();
    await expect(badge(page)).toHaveText(/^Season 1 · \d{4}-\d{2}-\d{2} – /);
    await expect(page).toHaveURL(/\/seasons\?w=\d{4}-\d{2}-\d{2}$/);
    // Season 1 has no previous season link (the week before is pre-season, nothing to show)
    await expect(page.getByRole("link", { name: /^← / })).toHaveCount(0);
    await checkPage(page);
    await noOverflow(page);
  });
});

test.describe("/saved", () => {
  const capitalText = (p: import("@playwright/test").Page) => p.getByText(/^your capital: /);

  for (const [c, want] of [
    ["0", "$10"],
    ["-5", "$10"],
    ["1e12", "$1,000,000"],
    ["abc", "$1,000"],
    ["12.6", "$13"],
    ["", "$1,000"],
  ]) {
    test(`capital c=${c || "(empty)"} reads as ${want}`, async ({ page }) => {
      await page.goto(`/saved?c=${c}`);
      await expect(capitalText(page)).toHaveText(`your capital: ${want}`);
      await expect(page.getByLabel("Capital you copy with (AUSD)")).toHaveValue(String(parseNum(want)));
      await checkPage(page);
    });
  }

  for (const [p, label] of [
    ["week", "7 days"],
    ["month", "30 days"],
    ["all", "All time"],
  ]) {
    test(`period ${p}: loss and bond math per row`, async ({ page }) => {
      await page.goto(`/saved?p=${p}&c=2500`);
      await expect(page.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      await expect(page.getByText(`app.perpl.xyz · leaderboard/${p}/pnl`)).toBeVisible();
      const ratio = parseNum(await page.getByText("Copas bond rule", { exact: true }).locator("..").locator(".num").first().innerText()) / 100;
      expect(ratio).toBeGreaterThan(0);
      const rows = page.locator("table tbody tr");
      await expect(rows).toHaveCount(10);
      for (const r of await rows.all()) {
        const t = await r.locator("td").allInnerTexts();
        const [pnl, roi, loss, back, net] = t.slice(1).map(parseNum);
        expect(pnl, t.join(" | ")).toBeLessThan(0);
        const want = 2500 * Math.min(1, Math.max(0, -roi) / 100);
        expect(Math.abs(-loss - want), t.join(" | ")).toBeLessThan(2500 * 0.0005 + 0.01); // ROI shown to 0.1%
        expect(back).toBeCloseTo(Math.min(-loss, 2500 * ratio), 1);
        expect(net).toBeCloseTo(loss + back, 1);
        expect(t[3], "money uses the − sign").toMatch(/^(−\$|\$0\.00$)/);
        expect(t[4]).toMatch(/^(\+\$|\$0\.00$)/);
      }
      // PnL column sorted, biggest loss first
      const pnls = (await rows.locator("td:nth-child(2)").allInnerTexts()).map(parseNum);
      expect([...pnls].sort((a, b) => a - b)).toEqual(pnls);
      await checkPage(page);
      await noOverflow(page);
    });
  }

  test("headline numbers match the raw Perpl leaderboard", async ({ page, request }) => {
    test.skip(!!test.info().project.use.isMobile, "data check, viewport-independent");
    await page.goto("/saved?p=month");
    const raw = await request.get("https://app.perpl.xyz/api/v1/trading/leaderboard/month/pnl");
    const d: { p: string }[] = (await raw.json()).d;
    const pnl = d.map((x) => Number(x.p) / 1e6).filter((x) => x !== 0);
    const lost = -pnl.filter((x) => x < 0).reduce((a, x) => a + x, 0);
    const share = (pnl.filter((x) => x < 0).length / pnl.length) * 100;
    const losers = page.getByText("Traders who lost money", { exact: true }).locator("..");
    // the page caches the leaderboard for a minute; live PnL drifts a little
    expect(Math.abs(parseNum(await losers.locator(".num").first().innerText()) - share)).toBeLessThan(3);
    const shownLost = parseNum(await page.getByText("Total lost by losing traders", { exact: true }).locator("..").locator(".num").innerText());
    expect(Math.abs(shownLost - lost) / lost).toBeLessThan(0.05);
  });

  test("the capital input accepts any whole amount and keeps the period", async ({ page }) => {
    await page.goto("/saved?p=week");
    const input = page.getByLabel("Capital you copy with (AUSD)");
    await input.fill("1234");
    expect(await input.evaluate((i: HTMLInputElement) => i.checkValidity()), "1234 is a valid amount").toBe(true);
    await page.getByRole("button", { name: "Recalculate" }).click();
    await expect(page).toHaveURL(/\?p=week&c=1234$/);
    await expect(capitalText(page)).toHaveText("your capital: $1,234");
    await page.getByRole("link", { name: "All time" }).click();
    await expect(page).toHaveURL(/\?p=all&c=1234$/);
    await expect(capitalText(page)).toHaveText("your capital: $1,234");
  });
});

test.describe("/become-leader: import a Hyperliquid track record", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/become-leader");
  });
  const addr = (p: import("@playwright/test").Page) => p.getByLabel("Hyperliquid address");
  const box = (p: import("@playwright/test").Page) => p.locator("section").filter({ has: p.getByRole("heading", { name: "Import your track record" }) });

  test("rejects a malformed address without calling the API", async ({ page }) => {
    let called = false;
    page.on("request", (r) => r.url().includes("/api/hyperliquid") && (called = true));
    await expect(box(page).getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    await addr(page).fill("0x123");
    await expect(addr(page)).toHaveAttribute("aria-invalid", "true");
    await box(page).getByRole("button", { name: "Import", exact: true }).click();
    await expect(box(page).getByRole("alert")).toHaveText("Enter a 0x address (40 hex characters).");
    expect(called).toBe(false);
    await checkPage(page);
    await noOverflow(page);
  });

  test("an address with no perps history says so", async ({ page, guard }) => {
    guard.allow(/\/api\/hyperliquid\?user=0x0{39}1$/, /status of 404/);
    await addr(page).fill("0x0000000000000000000000000000000000000001");
    await expect(async () => {
      await box(page).getByRole("button", { name: "Import", exact: true }).click();
      await expect(box(page).getByRole("alert")).toHaveText("This address has no Hyperliquid perps trades to import.", { timeout: 15_000 });
    }).toPass({ timeout: 60_000 });
  });

  test("a real trader: numbers match the API, Use this tier fills the mandate", async ({ page, request }) => {
    await addr(page).fill(WHALE);
    const dl = box(page).locator("dl");
    await expect(async () => {
      await box(page).getByRole("button", { name: "Import", exact: true }).click();
      await expect(dl).toBeVisible({ timeout: 20_000 });
    }).toPass({ timeout: 75_000 });
    const val = async (k: string) => dl.locator("div", { has: page.getByText(k, { exact: true }) }).locator("dd").innerText();
    const j = await (await request.get(`/api/hyperliquid?user=${WHALE}`)).json();
    // the account moves between the two reads: compare loosely
    expect(Math.abs(parseNum(await val("Account value")) - j.accountValue) / j.accountValue).toBeLessThan(0.05);
    expect(Math.abs(parseNum(await val("Max drawdown, all time")) - j.allTime.maxDD)).toBeLessThan(1);
    expect(await val("Current leverage")).toMatch(/^\d+\.\d{2}x · \d+ open$/);
    expect(await val("All-time volume")).toMatch(/^\$[\d.]+[KMBT]$/);
    expect(await val("30-day return")).toMatch(/^[−+]?\d+\.\d%$/);

    const dd = page.getByLabel("Max drawdown per epoch (%)");
    if (j.suggestion) {
      const name = { konservatif: "Conservative", moderat: "Moderate", agresif: "Aggressive" }[j.suggestion.tier as string]!;
      await expect(box(page).getByText(name, { exact: true })).toBeVisible();
      // start from a different tier so the click visibly changes the form
      const other = j.suggestion.tier === "agresif" ? "Conservative" : "Aggressive";
      await page.getByRole("group", { name: "Tier" }).getByRole("button", { name: new RegExp(`^${other}`) }).click();
      await box(page).getByRole("button", { name: "Use this tier" }).click();
      await expect(dd).toHaveValue(String(j.suggestion.maxDD));
      await expect(page.getByRole("group", { name: "Tier" }).getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-pressed", "true");
    } else {
      await expect(box(page).getByText(/would break even the 30% Aggressive mandate/)).toBeVisible();
    }
    // editing the address clears the previous trader's numbers
    await addr(page).fill("0x0000000000000000000000000000000000000002");
    await expect(dl).toHaveCount(0);
    await checkPage(page);
    await noOverflow(page);
  });
});

test.describe("API /api/hyperliquid", () => {
  test.skip(({ isMobile }) => isMobile, "API checks are viewport-independent");
  test("rejects bad input with 400", async ({ request }) => {
    for (const u of ["", "?user=", "?user=bad", "?user=0x31ca8395cf837de08b24da3f660e77761dfb974", "?user=0X31CA8395CF837DE08B24DA3F660E77761DFB974B"]) {
      const res = await request.get(`/api/hyperliquid${u}`);
      expect(res.status(), u).toBe(400);
      expect(await res.json()).toEqual({ error: "Enter a 0x address (40 hex characters)." });
    }
  });
});

test("landing live metrics strip matches the indexer", async ({ page, request }) => {
  const strip = page.getByRole("region", { name: "Live protocol metrics" });
  // both sources must answer: the indexer (counters) and the registry RPC (bond), which rate-limits now and then
  await gotoUntil(page, "/", () => [strip.getByText("LeaderBook.bond() · Envio indexer"), strip.getByText(/^across \d+ leaders?$/)]);
  const items = strip.locator("div.grid > div");
  await expect(items).toHaveCount(6);
  for (const v of await items.locator("p.num").allInnerTexts()) expect(v.trim()).toMatch(/^\d[\d,]*(\.\d+)?$/);
  // values must fit their column (nothing truncated with an ellipsis)
  const clipped = await items.locator("p.num").evaluateAll((ps) => ps.filter((p) => p.scrollWidth > p.clientWidth + 1).map((p) => p.textContent));
  expect(clipped).toEqual([]);
  const claims: { amountCNS: string }[] = (await (await request.post(ENVIO, { data: { query: "{ Claim(where: { chainId: { _eq: 10143 } }) { amountCNS } }" } })).json()).data.Claim;
  const slashed = claims.reduce((a, c) => a + Number(c.amountCNS) / 1e6, 0);
  const item = items.filter({ hasText: "AUSD slashes paid" });
  expect(Math.abs(parseNum(await item.locator("p.num").innerText()) - slashed)).toBeLessThan(0.0001);
  await expect(item).toContainText(`${claims.length} ${claims.length === 1 ? "claim" : "claims"} by followers`);
});

test("leader OG image is a 1200×630 PNG linked from the page", async ({ page, request }) => {
  await gotoUntil(page, `/leader/${ACTIVE}`, (p) => p.locator("h1"));
  const og = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(og).toMatch(new RegExp(`/leader/${ACTIVE}/opengraph-image`));
  const res = await request.get(og!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  const png = await res.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("header nav reaches Seasons and Reality check and marks the current page", async ({ page }) => {
  await page.goto("/");
  const desktop = (page.viewportSize()?.width ?? 0) >= 1280;
  const go = async (name: string) => {
    if (!desktop) await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation", { name: desktop ? "Main" : "Mobile" }).getByRole("link", { name, exact: true }).click();
  };
  await go("Seasons");
  await expect(page).toHaveURL(/\/seasons$/);
  await expect(page.getByRole("heading", { level: 1, name: "Seasons" })).toBeVisible();
  if (!desktop) await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("navigation", { name: desktop ? "Main" : "Mobile" }).getByRole("link", { name: "Seasons" })).toHaveAttribute("aria-current", "page");
  if (!desktop) await page.getByRole("button", { name: "Menu" }).click();
  await go("Reality check");
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page.getByRole("heading", { level: 1, name: "Would Copas have saved you?" })).toBeVisible();
  // desktop nav labels stay on one line
  if (desktop) for (const h of await page.getByRole("navigation", { name: "Main" }).getByRole("link").evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) expect(h).toBeLessThan(32);
  await noOverflow(page);
});
