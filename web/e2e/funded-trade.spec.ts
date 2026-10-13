import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { test, expect } from "./fixtures";

/**
 * Agora mobile trading flow for real, on Monad testnet, at phone size: a fresh Mera passkey account (CDP virtual
 * authenticator with PRF) gets gas + AUSD, opens its own Perpl account from /trade, opens a BTC long and closes it,
 * rests a limit buy below the market and cancels it, then withdraws. Every step is a passkey-signed tx checked against Perpl state read straight from chain.
 * Spends ~1 MON + 150 AUSD from FUNDER_KEY (most AUSD stays in the test account), so it runs only when that is set.
 */
const EX = "0x1964C32f0bE608E7D29302AFF5E61268E72080cc";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const BTC = 16n;
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } } as const;
const abi = parseAbi([
  "struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }",
  "struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }",
  "struct PositionInfo { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; }",
  "function getAccountByAddr(address) view returns (AccountInfo)",
  "function getPosition(uint256 perpId, uint256 accountId) view returns (PositionInfo, uint256, bool)",
  "struct OrderLock { uint32 orderLockId; uint32 nextOrderLockId; uint32 prevOrderLockId; uint8 orderType; uint40 lotLNS; uint80 amountCNS; }",
  "struct Order { uint32 accountId; uint8 orderType; uint24 priceONS; uint40 lotLNS; uint16 recycleFeeRaw; uint32 expiryBlock; uint16 leverageHdths; uint16 orderId; uint16 prevOrderId; uint16 nextOrderId; uint16 maxNegPnlCollatBPS; }",
  "function getPerpOrderLocks(uint256 accountId, uint256 perpId) view returns (OrderLock[])",
  "function getOrder(uint256 perpId, uint256 orderId) view returns (Order)",
]);

test("passkey account trades BTC on Perpl from /trade (mobile)", async ({ page, context, browserName, isMobile }) => {
  const key = process.env.FUNDER_KEY as `0x${string}` | undefined;
  test.skip(!key || !isMobile || browserName !== "chromium", "needs FUNDER_KEY and the mobile Chromium project");
  test.setTimeout(420_000);
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

  const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 5 }) });
  const funder = createWalletClient({ account: privateKeyToAccount(key!), chain, transport: http() });
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: me, value: parseEther("1") }) });
  await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: AUSD, abi: erc20Abi, functionName: "transfer", args: [me, 150_000_000n] }) });

  await page.goto("/trade");
  await main.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(main.getByRole("heading", { name: "Funds" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wallet-ausd")).toHaveText("150.00", { timeout: 30_000 });

  const txs: string[] = [];
  const status = page.getByTestId("trade-status");
  /** Waits for a status line carrying `text` and a tx link it has not shown before, and records the tx. */
  const waitTx = async (text: string) => {
    await expect(async () => {
      await expect(status).toContainText(text);
      const h = (await status.getByRole("link").getAttribute("href"))?.split("/tx/")[1];
      expect(h && !txs.includes(h)).toBeTruthy();
    }).toPass({ timeout: 150_000 });
    txs.push((await status.getByRole("link").getAttribute("href"))!.split("/tx/")[1]);
  };

  // 1. open the Perpl account with the minimum first deposit (approve + createAccount)
  await page.locator("#t-amt").fill("100");
  await main.getByRole("button", { name: "Open Perpl account" }).click();
  await waitTx("Perpl account opened.");
  const acct = await pub.readContract({ address: EX, abi, functionName: "getAccountByAddr", args: [me] });
  expect(acct.accountId).toBeGreaterThan(0n);
  expect(acct.balanceCNS).toBe(100_000_000n);

  // 2. the mandate rail blocks a market outside the mandate (ZEC is not in BTC/ETH/SOL), before any tx
  await page.getByRole("radio", { name: "ZEC" }).click();
  await page.locator("#t-size").fill("0.01");
  await expect(page.getByTestId("rail")).toContainText("✕ Market");
  await expect(main.getByRole("button", { name: /^Long 0.01 ZEC/ })).toBeDisabled();

  // 3. open a small BTC long at 3x (market IOC)
  await page.getByRole("radio", { name: "BTC" }).click();
  await page.locator("#t-size").fill("0.0002");
  await page.locator("#t-lev").fill("3");
  await expect(page.getByTestId("rail")).not.toContainText("✕");
  await main.getByRole("button", { name: "Long 0.0002 BTC · 3x" }).click();
  await waitTx("Filled 0.0002 BTC");
  const [open] = await pub.readContract({ address: EX, abi, functionName: "getPosition", args: [BTC, acct.accountId] });
  expect(open.lotLNS).toBe(20n);
  expect(open.positionType).toBe(0);
  await expect(page.getByTestId("pos-BTC")).toContainText("LONG", { timeout: 30_000 });

  // 4. close it (reduce-only CloseLong IOC)
  await page.getByTestId("pos-BTC").getByRole("button", { name: "Close position" }).click();
  await waitTx("Filled 0.0002 BTC");
  const [closed] = await pub.readContract({ address: EX, abi, functionName: "getPosition", args: [BTC, acct.accountId] });
  expect(closed.lotLNS).toBe(0n);

  // 5. a resting limit buy 3% under the mark (expiry 0, not IOC): it sits on Perpl's book with margin locked, then cancel it
  const markPx = Number((await page.getByTestId("mark").textContent())!.replace(/[^0-9.]/g, ""));
  expect(markPx).toBeGreaterThan(1000);
  await page.getByRole("radio", { name: "Limit (rests)" }).click();
  await page.locator("#t-size").fill("0.0002");
  await page.locator("#t-px").fill(String(Math.floor(markPx * 0.97)));
  await page.locator("#t-lev").fill("3");
  await main.getByRole("button", { name: "Long 0.0002 BTC · 3x" }).click();
  await waitTx("resting on the book");
  const orderId = BigInt((await status.textContent())!.match(/Order #(\d+)/)![1]);
  const locks = await pub.readContract({ address: EX, abi, functionName: "getPerpOrderLocks", args: [acct.accountId, BTC] });
  expect(locks.map((l) => BigInt(l.orderLockId & 0xffff))).toContain(orderId);
  const resting = await pub.readContract({ address: EX, abi, functionName: "getOrder", args: [BTC, orderId] });
  expect(BigInt(resting.accountId)).toBe(acct.accountId);
  expect(resting.lotLNS).toBe(20n);
  expect(resting.orderType).toBe(0);
  expect((await pub.readContract({ address: EX, abi, functionName: "getAccountByAddr", args: [me] })).lockedBalanceCNS).toBeGreaterThan(0n);
  const row = page.getByTestId(`order-${orderId}`);
  await expect(row).toContainText("BUY", { timeout: 30_000 });
  await row.getByRole("button", { name: "Cancel" }).click();
  await waitTx("Order cancelled.");
  const after = await pub.readContract({ address: EX, abi, functionName: "getPerpOrderLocks", args: [acct.accountId, BTC] });
  expect(after.map((l) => BigInt(l.orderLockId & 0xffff))).not.toContain(orderId);
  expect((await pub.readContract({ address: EX, abi, functionName: "getAccountByAddr", args: [me] })).lockedBalanceCNS).toBe(0n);
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("radio", { name: "Market (IOC)" }).click();

  // 6. withdraw 50 AUSD back to the wallet (risky: fresh passkey)
  await page.locator("#t-amt").fill("50");
  await main.getByRole("button", { name: "Withdraw" }).click();
  await waitTx("50 AUSD back in your wallet.");
  expect(await pub.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [me] })).toBe(100_000_000n);

  console.log(`account ${me} perpl #${acct.accountId}\n${txs.map((h) => `https://testnet.monadscan.com/tx/${h}`).join("\n")}`);
});
