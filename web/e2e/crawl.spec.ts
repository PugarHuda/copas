import { test, expect, checkPage, noOverflow, gotoUntil, ACTIVE, BREACHED, VAULT } from "./fixtures";

/**
 * Every route once per viewport: no console errors / failed requests (fixture guard), no forbidden text,
 * no horizontal scroll, no skeleton still pulsing after 20 s, and every internal link it renders resolves.
 */
const ROUTES: [string, string][] = [
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

for (const [path, ready] of ROUTES) {
  test(`crawl ${path}`, async ({ page, request }) => {
    test.setTimeout(180_000);
    await gotoUntil(page, path, (p) => p.locator(ready));
    await expect(page.locator(".animate-pulse"), "skeleton still loading after 20 s").toHaveCount(0, { timeout: 20_000 });
    await checkPage(page);
    await noOverflow(page);

    const origin = new URL(page.url()).origin;
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
    // one link per route shape (a leaderboard links hundreds of wallets): /analytics/wallet/0x… counts once
    const shape = (h: string) => h.replace(/0x[0-9a-fA-F]{40}/g, "0x").replace(/\/\d+(?=\/|$|\?)/g, "/n");
    const byShape = new Map<string, string>();
    for (const h of hrefs.filter((h) => h.startsWith(origin)).map((h) => h.split("#")[0])) if (!byShape.has(shape(h))) byShape.set(shape(h), h);
    await page.close(); // the landing's WebGL hero starves slow CI machines while the link checks run
    const statuses = await Promise.all([...byShape.values()].map(async (h) => [h, (await request.get(h, { timeout: 45_000 })).status()] as const));
    for (const [h, status] of statuses) expect(status, `${path} links to ${h}`).toBeLessThan(400);
  });
}

/** Odd but well-formed URLs a user can paste: each renders an honest state, never a crash or NaN. */
const NOBODY = "0x0000000000000000000000000000000000000001";
for (const [path, text] of [
  [`/leader/${NOBODY}`, /has not posted a Copas bond/],
  [`/leader/${ACTIVE.toLowerCase()}`, /0xda69…3D90/i],
  [`/follow/${NOBODY}`, /Only bonded leaders can be followed\./],
  [`/analytics/wallet/${NOBODY}`, /no Perpl exchange account/],
  [`/analytics/compare?w=${NOBODY},garbage,123`, /Pick 2 to 3 wallets/],
  [`/me?vault=${NOBODY}`, /No vault for 0x0000…0001 yet\./],
  ["/me?vault=garbage", /That is not a 0x address \(40 hex characters\)\./],
  ["/me?owner=0x123", /That is not a 0x address \(40 hex characters\)\./],
] as const) {
  test(`edge URL ${path}`, async ({ page }) => {
    await gotoUntil(page, path, (p) => p.getByText(text));
    await checkPage(page);
    await noOverflow(page);
  });
}
