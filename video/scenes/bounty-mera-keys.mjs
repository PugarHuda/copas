// Mera "One Passkey, Many Keys" bounty: the web/e2e/feed.spec.ts flow, for real on testnet. Off camera, leader L opens a
// LeaderBook, follower F (the recorded page) follows it, both publish the X25519 feed key from the second PRF salt, and L posts
// a sealed note. On camera: F decrypts it; then a fresh passkey N (not following) unlocks and still sees it locked.
// Funds from FUNDER_KEY (web/.env.local TESTNET_FAUCET_KEY, our own testnet faucet): ~3 MON + ~225 AUSD per recording.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/package.json"));
const { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const REGISTRY = "0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d";
const FEED = "0x75d52573C684C7799778Da633fDceB80297d7718";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } };
const abi = parseAbi(["function leadersOf(address) view returns (address[])", "function epoch() view returns (uint256)", "function bond() view returns (uint256)", "function accountId() view returns (uint256)", "function feedKey(address) view returns (bytes32)"]);
const ZERO32 = `0x${"0".repeat(64)}`;
const AUTH = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true };
const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 5 }) });
const read = (address, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const poll = async (f, ok, ms = 150_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f().catch(() => undefined); if (v !== undefined && ok(v)) return v; await new Promise((r) => setTimeout(r, 2000)); } throw new Error("poll timeout"); };
let book, note, postTx;

async function fund(to, mon, ausd) {
  const funder = createWalletClient({ account: privateKeyToAccount(process.env.FUNDER_KEY), chain, transport: http() });
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to, value: parseEther(mon) }) });
  await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: AUSD, abi: erc20Abi, functionName: "transfer", args: [to, ausd] }) });
}
async function create(page) {
  await page.goto("/settings");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: /Create passkey account/ }).click();
  await main.getByText(/^signed in$/).waitFor({ timeout: 60_000 });
  return (await main.locator(".num.break-all").first().textContent()).trim();
}
const signIn = async (page) => {
  await page.getByRole("button", { name: "Sign in with passkey" }).first().click();
  await page.getByRole("button", { name: "Sign in with passkey" }).last().click();
};
const feedPanel = (p) => p.locator("section").filter({ hasText: "Strategy notes (encrypted)" });
async function publish(page, address) {
  await page.goto(`/leader/${book}`);
  await signIn(page);
  await feedPanel(page).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
  await feedPanel(page).getByRole("button", { name: "Publish feed key (once)" }).click();
  await poll(() => read(FEED, "feedKey", [address]), (v) => v !== ZERO32, 120_000);
}

export default {
  setup: async (c) => {
    // L, in its own unrecorded context
    const lc = await c.context.browser().newContext({ baseURL: "https://copas-mocha.vercel.app", viewport: { width: 1440, height: 900 } });
    const L = await lc.newPage();
    const lcdp = await lc.newCDPSession(L);
    await lcdp.send("WebAuthn.enable");
    await lcdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTH });
    L.on("response", async (r) => { if (r.request().method() === "POST" && r.request().postData()?.includes("eth_sendRawTransaction")) { const j = await r.json().catch(() => null); for (const x of [j].flat()) if (typeof x?.result === "string") postTx = x.result; } });
    const la = await create(L);
    await fund(la, "2", 130_000_000n);
    await L.goto("/become-leader");
    await signIn(L);
    const lm = L.getByRole("main");
    await lm.getByRole("button", { name: "Open LeaderBook" }).click();
    await poll(() => read(REGISTRY, "leadersOf", [la]), (v) => v.length === 1, 120_000);
    book = (await read(REGISTRY, "leadersOf", [la]))[0];
    console.log(`  leader ${la} book ${book}`);
    for (const [name, check] of [["Deposit", async () => (await read(book, "accountId")) > 0n], ["Post bond", async () => (await read(book, "bond")) === 25_000_000n], ["Start", async () => (await read(book, "epoch")) === 1n]]) {
      const b = lm.getByRole("button", { name, exact: true });
      await b.waitFor({ timeout: 30_000 });
      for (let i = 0; i < 30 && !(await b.isEnabled()); i++) await c.sleep(1000);
      await b.click();
      await poll(check, (v) => v, 150_000);
    }
    await publish(L, la);
    // F = the recorded page
    await c.cdp.send("WebAuthn.enable");
    c.fAuth = (await c.cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTH })).authenticatorId;
    const fa = await create(c.page);
    await fund(fa, "1", 100_000_000n);
    await c.page.goto(`/follow/${book}`);
    await signIn(c.page);
    await c.page.getByRole("button", { name: /Follow .* with/ }).waitFor({ timeout: 30_000 });
    await c.page.locator("#f-deposit").fill("100");
    await c.page.locator("#f-notional").fill("20");
    await c.page.getByLabel("I understand these limits on protection.").check();
    await c.page.getByRole("button", { name: /Follow .* with 100 AUSD/ }).click();
    await c.page.getByText("Vault active.").waitFor({ timeout: 240_000 });
    await publish(c.page, fa);
    console.log(`  follower ${fa}`);
    // L posts the note
    note = "BTC long bias this week, max 3x, cut at -5%. (Copas demo note)";
    await L.reload();
    await signIn(L);
    await feedPanel(L).getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 60_000 });
    await feedPanel(L).locator("textarea").fill(note);
    await feedPanel(L).getByRole("button", { name: "Send to followers" }).click();
    await feedPanel(L).getByText("Posted, encrypted for 2 readers.").waitFor({ timeout: 120_000 });
    console.log(`  posted ${postTx}`);
    await lc.close();
  },
  scenes: [
    {
      id: "follower",
      vo: "One passkey, many keys. From the same Mera passkey, Copas derives a second key with another PRF salt: an X25519 key for an encrypted strategy feed. This leader just posted a note to its followers. Only ciphertext goes onchain. I am a follower: I unlock with my passkey, and the note decrypts right here in the browser.",
      prep: async (c) => { await c.goto(`/leader/${book}`, "Strategy notes (encrypted)"); await signIn(c.page); await c.sleep(1500); await feedPanel(c.page).scrollIntoViewIfNeeded(); await c.page.evaluate(() => window.scrollBy(0, -150)); },
      run: async (c) => {
        await c.move(feedPanel(c.page).getByText("Strategy notes (encrypted)"));
        await c.sleep(4000);
        await c.click(feedPanel(c.page).getByRole("button", { name: "Unlock with passkey" }));
        await feedPanel(c.page).getByText(note).waitFor({ timeout: 60_000 });
        await c.move(feedPanel(c.page).getByText(note));
      },
    },
    {
      id: "outsider",
      vo: "Now a different passkey, an account that does not follow this leader. It unlocks its own feed key the same way, but the post stays locked: encrypted for two readers, the leader and its follower.",
      prep: async (c) => {
        await c.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: c.fAuth });
        await c.cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTH });
        await c.page.goto("/settings");
        await c.page.getByRole("main").getByRole("button", { name: /Clear/ }).click().catch(() => {});
        await c.page.waitForLoadState("load");
        console.log(`  outsider ${await create(c.page)}`);
        await c.goto(`/leader/${book}`, "Strategy notes (encrypted)");
        await signIn(c.page);
        await c.sleep(1500);
        await feedPanel(c.page).scrollIntoViewIfNeeded();
        await c.page.evaluate(() => window.scrollBy(0, -150));
      },
      run: async (c) => {
        await c.sleep(1500);
        await c.click(feedPanel(c.page).getByRole("button", { name: "Unlock with passkey" }));
        await feedPanel(c.page).getByText("Encrypted for 2 readers").waitFor({ timeout: 60_000 });
        await c.move(feedPanel(c.page).getByText("Encrypted for 2 readers"));
      },
    },
    {
      id: "tx",
      vo: "And the post transaction on the explorer: the CopasFeed contract stores only the sealed bytes.",
      prep: (c) => c.tx(postTx),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(1500); await c.scroll(450, 1500); },
    },
  ],
};
