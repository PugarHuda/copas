// Kuru bounty: the per-leader DOWN market on Kuru, and a real 1 AUSD market buy from a fresh passkey wallet.
// Setup (off camera) creates the passkey account and funds it from our own test accounts (contracts/.env).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/package.json"));
const { createPublicClient, createWalletClient, erc20Abi, http, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const GOOD = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } };
let txUrl;

export default {
  setup: async (c) => {
    await c.cdp.send("WebAuthn.enable");
    await c.cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    await c.goto("/settings", "Create passkey account");
    const main = c.page.getByRole("main");
    await main.getByRole("button", { name: /Create passkey account/ }).click();
    await main.getByText(/^signed in$/).waitFor({ timeout: 60_000 });
    const me = (await main.locator(".num.break-all").first().textContent()).trim();
    const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 5 }) });
    const gas = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_KEY), chain, transport: http() });
    const usd = createWalletClient({ account: privateKeyToAccount(process.env.UNDERWRITER_KEY), chain, transport: http() });
    await pub.waitForTransactionReceipt({ hash: await gas.sendTransaction({ to: me, value: parseEther("0.5") }) });
    await pub.waitForTransactionReceipt({ hash: await usd.writeContract({ address: AUSD, abi: erc20Abi, functionName: "transfer", args: [me, 5_000_000n] }) });
    console.log(`  passkey account ${me} funded`);
  },
  scenes: [
    {
      id: "intro",
      vo: "Copas lists a new kind of asset on Kuru: a market on whether a trader keeps their word. For every leader and every epoch, the BreachMarket contract mints UP and DOWN. One AUSD mints one of each. At the end of the epoch, DOWN pays one AUSD if the leader broke the mandate, and UP pays if they did not.",
      prep: (c) => c.goto(`/market/${GOOD}`, "Breach odds (DOWN price)"),
      run: async (c) => {
        await c.move(c.page.getByText(/DOWN · 0X/i).first());
        await c.sleep(2500);
        await c.move(c.page.getByText(/Deposit 1 AUSD, get 1 UP/));
        await c.sleep(5000);
        await c.move("Breach odds (DOWN price)");
        await c.sleep(2500);
        await c.move("Pairs outstanding");
      },
    },
    {
      id: "book",
      vo: "DOWN trades against AUSD on a Kuru order book. The keeper's market maker mints each epoch's series, lists it on Kuru, and quotes both sides. The page reads the depth straight from the book contract, so DOWN's price is the market's breach probability.",
      run: async (c) => {
        await c.scrollTo(c.page.getByText("DOWN/AUSD order book (Kuru)"), 1500);
        await c.move(c.page.getByText("Best ask"));
        await c.sleep(2500);
        await c.move(c.page.getByText("Best bid"));
        await c.sleep(2500);
        await c.move(c.page.getByText(/L2 depth from Kuru/));
        await c.sleep(2500);
        await c.move(c.page.getByText("Mint and redeem"));
      },
    },
    {
      id: "trade",
      vo: "Now a real trade. I sign in with a passkey and spend one AUSD on DOWN, a hedge against this leader breaking the mandate. The quote walks the book and includes Kuru's taker fee. The passkey signs the approval and the market order, and it fills onchain.",
      prep: async (c) => { await c.goto(`/market/${GOOD}`, "Recent fills (Kuru)"); await c.page.getByText("Trade DOWN on Kuru").first().scrollIntoViewIfNeeded(); await c.page.evaluate(() => window.scrollBy(0, -300)); },
      run: async (c) => {
        const amt = c.page.locator("#kuru-amt");
        // the passkey session lives in memory, so a fresh page load signs in again (stateless, same passkey)
        await c.click(c.page.getByRole("banner").getByRole("button", { name: /Sign in with passkey/ }).first());
        await c.sleep(600);
        await c.click(c.page.getByRole("banner").getByRole("button", { name: /Sign in with passkey/ }).nth(1));
        await amt.waitFor({ timeout: 60_000 });
        await c.scrollTo(c.page.getByRole("heading", { name: "Trade DOWN on Kuru" }), 1500);
        await c.click(c.page.getByRole("radio", { name: "Buy DOWN" }));
        await c.click(amt);
        await amt.fill("");
        await amt.pressSequentially("1", { delay: 120 });
        await c.move(c.page.getByText(/About .* DOWN \(avg/));
        await c.sleep(2500);
        await c.click(c.page.getByRole("button", { name: "Buy DOWN on Kuru" }));
        const ok = c.page.getByRole("status").filter({ hasText: "Filled." });
        await ok.waitFor({ timeout: 120_000 });
        txUrl = await ok.getByRole("link").getAttribute("href");
        console.log(`  kuru fill ${txUrl}`);
        await c.move(ok);
      },
    },
    {
      id: "fills",
      vo: "The fill shows up in Recent fills, read from Kuru's Trade events through Envio HyperSync, and the order book updates.",
      prep: async (c) => {
        // HyperSync can lag the chain by a little: reload until the fill is listed
        for (let i = 0; i < 8; i++) {
          await c.goto(`/market/${GOOD}`, "Recent fills (Kuru)");
          await c.sleep(3000);
          if (!(await c.page.getByText("No fills on this book yet").count())) break;
          await c.sleep(10_000);
        }
      },
      run: async (c) => {
        await c.scrollTo(c.page.getByText("Recent fills (Kuru)"), 1500);
        await c.move(c.page.getByText("Recent fills (Kuru)"));
      },
    },
    {
      id: "tx",
      vo: "Here is that market buy on the Monad explorer.",
      prep: (c) => c.tx((txUrl ?? "/tx/0x2411b4c3caa3494f51ede921e1eb8ced2c1a4f9725dc014f7d384fa3fb93aadb").split("/tx/")[1]),
      run: async (c) => { await c.move([700, 330], 1200); },
    },
  ],
};
