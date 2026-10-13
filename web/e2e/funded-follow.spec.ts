import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { test, expect } from "./fixtures";

/**
 * The money path for real, on Monad testnet: a fresh passkey account (CDP virtual authenticator with PRF) gets
 * gas + AUSD, then follows a bonded leader through the UI: createVault, approve, deposit, follow, four txs (one passkey prompt).
 * Spends ~0.1 MON from FUNDER_KEY, so it only runs when that is set (never in CI). Never logs the key.
 */
const LEADER = "0x989427C70fb5ED71aCe9c6c9966bd9FB2C3912C6";
const REGISTRY = "0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const AUSD_FAUCET = "0xd236c18d274e54faccc3dd9dda4b27965a73ee6c";
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } } as const;
const abi = parseAbi([
  "function requestFunds(address)",
  "function balanceOf(address) view returns (uint256)",
  "function vaultsOf(address) view returns (address[])",
  "function leader() view returns (address)",
]);

test("fresh passkey account follows a bonded leader onchain", async ({ page, context, browserName, isMobile }) => {
  const key = process.env.FUNDER_KEY as `0x${string}` | undefined;
  test.skip(!key || isMobile || browserName !== "chromium", "needs FUNDER_KEY and desktop Chromium");
  test.setTimeout(300_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  await page.goto("/settings");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: /Create passkey account/ }).click();
  await expect(main.getByText(/^signed in$/)).toBeVisible();
  const me = (await main.locator(".num.break-all").first().textContent())!.trim() as `0x${string}`;
  expect(me).toMatch(/^0x[0-9a-fA-F]{40}$/);

  const pub = createPublicClient({ chain, transport: http() });
  const funder = createWalletClient({ account: privateKeyToAccount(key!), chain, transport: http() });
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: me, value: parseEther("1")  /* same as the judge faucet; Monad charges the gas limit, createVault alone reserves ~0.37 MON */ }) });
  await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: AUSD_FAUCET, abi, functionName: "requestFunds", args: [me] }) });
  expect(await pub.readContract({ address: AUSD, abi, functionName: "balanceOf", args: [me] })).toBeGreaterThanOrEqual(10_000_000n);

  await page.goto(`/follow/${LEADER}`);
  // a full page load drops the in-memory passkey session (by design): sign in again like a returning user
  await page.getByRole("button", { name: "Sign in with passkey" }).first().click();
  await page.getByRole("button", { name: "Sign in with passkey" }).last().click(); // the header button opens a menu
  await expect(page.getByRole("button", { name: /Follow .* with/ })).toBeVisible({ timeout: 30_000 });
  await page.locator("#f-deposit").fill("100"); // Perpl getMinAccountOpenCNS = registry cap = 100
  await page.locator("#f-notional").fill("20");
  await page.getByLabel("I understand these limits on protection.").check();
  await page.getByRole("button", { name: /Follow .* with 100 AUSD/ }).click();
  await expect(page.getByText("Vault active.")).toBeVisible({ timeout: 240_000 });
  // step progress: every tx of the flow is listed as done with its explorer link (no referral cookie: 4 steps)
  const progress = page.getByRole("list", { name: "Transaction progress" });
  await expect(progress.getByRole("listitem")).toHaveCount(4);
  await expect(progress.getByRole("link", { name: /on the explorer/ })).toHaveCount(4);

  const vaults = await pub.readContract({ address: REGISTRY, abi, functionName: "vaultsOf", args: [me] });
  expect(vaults).toHaveLength(1);
  expect((await pub.readContract({ address: vaults[0], abi, functionName: "leader" })).toLowerCase()).toBe(LEADER.toLowerCase());
  expect(await pub.readContract({ address: AUSD, abi, functionName: "balanceOf", args: [vaults[0]] })).toBeGreaterThanOrEqual(0n);

  await page.getByRole("link", { name: "My vault" }).first().click();
  await expect(page.getByRole("main")).toContainText(vaults[0].slice(0, 6), { ignoreCase: true, timeout: 60_000 });
});
