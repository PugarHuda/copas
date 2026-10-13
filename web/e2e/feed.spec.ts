import { expect, test, type Browser } from "@playwright/test";
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Mera "One Passkey, Many Keys" for real, on Monad testnet. Three test accounts, each its own CDP virtual authenticator with PRF:
 * L opens a LeaderBook from /become-leader (deposit, bond, start), F follows it with 100 AUSD, both publish the X25519 feed key
 * from the second PRF salt, L posts a note sealed for its readers, F decrypts it in the browser, N (not following) sees it locked.
 * Spends ~3 MON + ~225 AUSD from FUNDER_KEY, so it runs only when that is set.
 */
const REGISTRY = "0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d";
const FEED = "0x75d52573C684C7799778Da633fDceB80297d7718";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } } as const;
const abi = parseAbi([
  "function leadersOf(address) view returns (address[])",
  "function status() view returns (uint8)",
  "function epoch() view returns (uint256)",
  "function bond() view returns (uint256)",
  "function accountId() view returns (uint256)",
  "function feedKey(address) view returns (bytes32)",
  "function posts(address) view returns (bytes[])",
]);
const ZERO32 = `0x${"0".repeat(64)}`;

/** A fresh browser context with its own passkey authenticator; records every tx hash the page broadcasts. */
async function account(browser: Browser, name: string) {
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || "https://copas-mocha.vercel.app", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  const txs: string[] = [];
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !r.request().postData()?.includes("eth_sendRawTransaction")) return;
    const j = await r.json().catch(() => null);
    for (const x of [j].flat()) if (typeof x?.result === "string") {
      txs.push(x.result);
      console.log(`${name} tx ${x.result}`);
    }
  });
  await page.goto("/settings");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: /Create passkey account/ }).click();
  await expect(main.getByText(/^signed in$/)).toBeVisible();
  const address = (await main.locator(".num.break-all").first().textContent())!.trim() as `0x${string}`;
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  console.log(`${name} ${address}`);
  /** A full page load drops the in-memory session (by design): sign in again from the header menu. */
  const signIn = async () => {
    await page.getByRole("button", { name: "Sign in with passkey" }).first().click();
    await page.getByRole("button", { name: "Sign in with passkey" }).last().click();
  };
  return { context, page, address, txs, signIn };
}

test("encrypted strategy note: leader posts, follower decrypts, non-follower stays locked", async ({ browser, browserName }, info) => {
  const key = process.env.FUNDER_KEY as `0x${string}` | undefined;
  test.skip(!key || browserName !== "chromium" || info.project.name !== "desktop", "needs FUNDER_KEY and desktop Chromium");
  test.setTimeout(900_000);
  const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 5 }) });
  const funder = createWalletClient({ account: privateKeyToAccount(key!), chain, transport: http() });
  const fund = async (to: `0x${string}`, mon: string, ausd: bigint) => {
    await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to, value: parseEther(mon) }) });
    await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: AUSD, abi: erc20Abi, functionName: "transfer", args: [to, ausd] }) });
  };
  const read = <T,>(address: `0x${string}`, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // 1. L: a LeaderBook from /become-leader (open, deposit 100, bond 25, start)
  const L = await account(browser, "L");
  await fund(L.address, "2", 130_000_000n);
  await L.page.goto("/become-leader");
  await L.signIn();
  const lmain = L.page.getByRole("main");
  await lmain.getByRole("button", { name: "Open LeaderBook" }).click();
  await expect.poll(async () => (await read<string[]>(REGISTRY, "leadersOf", [L.address])).length, { timeout: 120_000 }).toBe(1);
  const book = (await read<`0x${string}`[]>(REGISTRY, "leadersOf", [L.address]))[0];
  console.log(`book ${book}`);
  await expect(lmain.getByRole("button", { name: "Deposit", exact: true })).toBeEnabled({ timeout: 30_000 });
  await lmain.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect.poll(() => read<bigint>(book, "accountId"), { timeout: 150_000 }).toBeGreaterThan(0n);
  await expect(lmain.getByRole("button", { name: "Post bond" })).toBeEnabled({ timeout: 30_000 });
  await lmain.getByRole("button", { name: "Post bond" }).click();
  await expect.poll(() => read<bigint>(book, "bond"), { timeout: 150_000 }).toBe(25_000_000n);
  await expect(lmain.getByRole("button", { name: "Start", exact: true })).toBeEnabled({ timeout: 30_000 });
  await lmain.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => read<bigint>(book, "epoch"), { timeout: 120_000 }).toBe(1n);
  expect(await read<number>(book, "status")).toBe(0); // Active

  // L publishes its feed key
  const feedPanel = (p: typeof L.page) => p.locator("section").filter({ hasText: "Strategy notes (encrypted)" });
  const unlockAndPublish = async (a: typeof L) => {
    await a.page.goto(`/leader/${book}`);
    await a.signIn();
    await feedPanel(a.page).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
    await feedPanel(a.page).getByRole("button", { name: "Publish feed key (once)" }).click();
    await expect.poll(() => read<string>(FEED, "feedKey", [a.address]), { timeout: 120_000 }).not.toBe(ZERO32);
  };
  await unlockAndPublish(L);

  // 2. F follows L with exactly 100 AUSD (Perpl minimum), then publishes its feed key
  const F = await account(browser, "F");
  await fund(F.address, "1", 100_000_000n);
  await F.page.goto(`/follow/${book}`);
  await F.signIn();
  await expect(F.page.getByRole("button", { name: /Follow .* with/ })).toBeVisible({ timeout: 30_000 });
  await F.page.locator("#f-deposit").fill("100");
  await F.page.locator("#f-notional").fill("20");
  await F.page.getByLabel("I understand these limits on protection.").check();
  await F.page.getByRole("button", { name: /Follow .* with 100 AUSD/ }).click();
  await expect(F.page.getByText("Vault active.")).toBeVisible({ timeout: 240_000 });
  await unlockAndPublish(F);

  // L posts a note
  const note = `Copas feed e2e ${new Date().toISOString()}: BTC long bias, max 3x, cut at -5%.`;
  await L.page.reload();
  await L.signIn();
  await feedPanel(L.page).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
  await feedPanel(L.page).locator("textarea").fill(note);
  await feedPanel(L.page).getByRole("button", { name: "Send to followers" }).click();
  await expect(feedPanel(L.page)).toContainText("Posted, encrypted for 2 readers.", { timeout: 120_000 });
  await expect(feedPanel(L.page)).toContainText(note);
  const blobs = await read<string[]>(FEED, "posts", [L.address]);
  expect(blobs).toHaveLength(1);
  expect(Buffer.from(blobs[0].slice(2), "hex").toString()).not.toContain("BTC long bias"); // ciphertext only

  // F decrypts it in its own browser
  await F.page.reload();
  await F.signIn();
  await feedPanel(F.page).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
  await expect(feedPanel(F.page)).toContainText(note, { timeout: 60_000 });
  await F.page.screenshot({ path: "test-results/feed-follower.png", fullPage: true });

  // 3. N (no vault) unlocks with its own passkey and still sees only the locked post
  await F.context.close();
  const N = await account(browser, "N");
  await N.page.goto(`/leader/${book}`);
  await N.signIn();
  await feedPanel(N.page).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
  await expect(feedPanel(N.page).getByRole("button", { name: "Publish feed key (once)" })).toBeVisible(); // unlocked, key derived
  await expect(feedPanel(N.page)).toContainText("Encrypted for 2 readers");
  await expect(feedPanel(N.page)).not.toContainText("BTC long bias");
  await N.page.screenshot({ path: "test-results/feed-outsider.png", fullPage: true });

  console.log(`leader L ${L.address} book ${book} follower F ${F.address} outsider N ${N.address}\nL txs ${L.txs.join(" ")}\nF txs ${F.txs.join(" ")}`);
  await N.context.close();
  await L.context.close();
});
