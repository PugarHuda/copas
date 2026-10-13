// Agora mobile bounty: a fresh Mera passkey account at 390px trades BTC on Perpl from /trade, for real, on Monad testnet.
// Same flow as web/e2e/funded-trade.spec.ts. Funding (1 MON from DEPLOYER_KEY, 150 AUSD from UNDERWRITER_KEY, our own
// test accounts in contracts/.env) happens off camera between scenes. Spends testnet funds on every recording.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/package.json"));
const { createPublicClient, createWalletClient, erc20Abi, http, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } };
let me;

const main = (c) => c.page.getByRole("main");
const status = (c) => c.page.getByTestId("trade-status");
const seen = new Set();
/** wait for a status line with `text` and a tx link not shown before */
async function waitTx(c, text) {
  for (let i = 0; i < 300; i++) {
    const t = (await status(c).textContent().catch(() => "")) || "";
    const h = await status(c).getByRole("link").getAttribute("href", { timeout: 200 }).catch(() => null);
    if (t.includes(text) && h && !seen.has(h)) { seen.add(h); console.log(`  ${text} ${h}`); return; }
    if (/fail|error|revert/i.test(t)) console.log(`  status: ${t}`);
    await c.sleep(500);
  }
  throw new Error(`timeout waiting for "${text}"`);
}
async function type(c, sel, v) {
  const l = c.page.locator(sel);
  await c.move(l, 500);
  if ((await l.getAttribute("type")) === "range") return l.fill(v);
  await l.fill("");
  await l.pressSequentially(v, { delay: 70 });
}

export default {
  mobile: true,
  stateful: true,
  scenes: [
    {
      id: "signin",
      vo: "This is Copas at phone size, the installable mobile app. The account is a Mera passkey. One tap creates it, with no seed phrase and no browser extension.",
      prep: async (c) => {
        const cdp = c.cdp;
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
        await c.goto("/settings", "Create passkey account");
      },
      run: async (c) => {
        await c.sleep(2500);
        await c.click(main(c).getByRole("button", { name: /Create passkey account/ }));
        await main(c).getByText(/^signed in$/).waitFor({ timeout: 60_000 });
        me = (await main(c).locator(".num.break-all").first().textContent()).trim();
        console.log(`  account ${me}`);
        await c.move(main(c).locator(".num.break-all").first());
      },
    },
    {
      id: "funds",
      vo: "We sent this fresh test account some testnet MON for gas and 150 AUSD from our own faucet wallet. On the trade screen I sign in with the same passkey, and Funds shows the 150 AUSD in the wallet.",
      prep: async (c) => {
        const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 5 }) });
        const gas = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_KEY), chain, transport: http() });
        const usd = createWalletClient({ account: privateKeyToAccount(process.env.UNDERWRITER_KEY), chain, transport: http() });
        await pub.waitForTransactionReceipt({ hash: await gas.sendTransaction({ to: me, value: parseEther("1") }) });
        await pub.waitForTransactionReceipt({ hash: await usd.writeContract({ address: AUSD, abi: erc20Abi, functionName: "transfer", args: [me, 150_000_000n] }) });
        await c.goto("/trade", "Sign in with passkey");
      },
      run: async (c) => {
        await c.sleep(3000);
        await c.click(main(c).getByRole("button", { name: "Sign in with passkey" }));
        await main(c).getByRole("heading", { name: "Funds" }).waitFor({ timeout: 30_000 });
        await c.page.getByText("150.00").first().waitFor({ timeout: 30_000 });
        await c.scrollTo(main(c).getByRole("heading", { name: "Funds" }), 1200);
        await c.move(c.page.getByTestId("wallet-ausd"));
      },
    },
    {
      id: "open",
      vo: "The first deposit opens a Perpl account owned by this passkey wallet. One hundred AUSD of margin, approved and deposited in passkey-signed transactions, straight to Perpl's exchange contract.",
      run: async (c) => {
        await type(c, "#t-amt", "100");
        await c.click(main(c).getByRole("button", { name: "Open Perpl account" }));
        await waitTx(c, "Perpl account opened.");
        await c.move(c.page.getByTestId("perpl-balance"));
      },
    },
    {
      id: "rail",
      vo: "Before I can sign, every order is checked against my own mandate. ZEC is not one of my allowed markets, so the button stays disabled. BTC, 0.0002 at three x, passes every check on the rail.",
      prep: async (c) => { await c.page.getByRole("radio", { name: "ZEC" }).scrollIntoViewIfNeeded(); await c.page.evaluate(() => window.scrollBy(0, -120)); },
      run: async (c) => {
        await c.click(c.page.getByRole("radio", { name: "ZEC" }));
        await type(c, "#t-size", "0.01");
        await c.move(c.page.getByTestId("rail"));
        await c.sleep(2500);
        await c.click(c.page.getByRole("radio", { name: "BTC" }));
        await type(c, "#t-size", "0.0002");
        await type(c, "#t-lev", "3");
        await c.move(c.page.getByTestId("rail"));
      },
    },
    {
      id: "long",
      vo: "Long 0.0002 BTC at three x. The passkey signs, the market order fills on Perpl, and the position card shows the side, size, PnL and liquidation price, read from the exchange.",
      run: async (c) => {
        await c.click(main(c).getByRole("button", { name: "Long 0.0002 BTC · 3x" }));
        await waitTx(c, "Filled 0.0002 BTC");
        await c.move(status(c));
        await c.page.getByTestId("pos-BTC").getByText("LONG").waitFor({ timeout: 30_000 });
        await c.scrollTo(c.page.getByTestId("pos-BTC"), 1000);
        await c.move(c.page.getByTestId("pos-BTC"));
      },
    },
    {
      id: "close",
      vo: "Closing is a reduce-only order. One tap, and it fills.",
      run: async (c) => {
        await c.click(c.page.getByTestId("pos-BTC").getByRole("button", { name: "Close position" }));
        await waitTx(c, "Filled 0.0002 BTC");
      },
    },
    {
      id: "limit",
      vo: "Next, a limit buy three percent under the mark. It rests on Perpl's order book with its margin locked, and it shows up as a resting order. Cancel takes it off the book and releases the margin.",
      run: async (c) => {
        const markPx = Number((await c.page.getByTestId("mark").textContent()).replace(/[^0-9.]/g, ""));
        await c.click(c.page.getByRole("radio", { name: "Limit (rests)" }));
        await type(c, "#t-size", "0.0002");
        await type(c, "#t-px", String(Math.floor(markPx * 0.97)));
        await c.click(main(c).getByRole("button", { name: "Long 0.0002 BTC · 3x" }));
        await waitTx(c, "resting on the book");
        const orderId = (await status(c).textContent()).match(/Order #(\d+)/)[1];
        const row = c.page.getByTestId(`order-${orderId}`);
        await row.getByText("BUY").waitFor({ timeout: 30_000 });
        await c.scrollTo(row, 800);
        await c.click(row.getByRole("button", { name: "Cancel" }));
        await waitTx(c, "Order cancelled.");
        await c.page.getByRole("radio", { name: "Market (IOC)" }).click();
      },
    },
    {
      id: "ausd",
      vo: "Further down, the AUSD card checks the dollar under all of this three ways: Agora's own API, the token's supply read onchain, and the latest Grant Thornton reserve report.",
      run: async (c) => {
        await c.scrollTo(c.page.getByTestId("ausd-supply"), 2500);
        await c.move(c.page.getByTestId("ausd-supply"));
        await c.sleep(2500);
        await c.scroll(300, 1500);
        await c.move(c.page.getByTestId("ausd-attest"));
      },
    },
  ],
};
