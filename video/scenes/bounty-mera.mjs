// Mera UX bounty: the passkey is the whole account layer (web/e2e/passkey.spec.ts flow, recorded on production
// with a CDP virtual authenticator that evaluates PRF).
const main = (c) => c.page.getByRole("main");
const addr = (c) => main(c).locator(".num.break-all").first();

export default {
  stateful: true,
  setup: async (c) => {
    await c.cdp.send("WebAuthn.enable");
    await c.cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  },
  scenes: [
    {
      id: "create",
      vo: "In Copas, a Mera passkey is the whole account. One tap creates it. The address is derived from the passkey's PRF output: no seed phrase, no browser extension, and no key stored on any server.",
      prep: (c) => c.goto("/settings", "Create passkey account"),
      run: async (c) => {
        await c.sleep(1500);
        await c.click(main(c).getByRole("button", { name: /Create passkey account/ }));
        await main(c).getByText(/^signed in$/).waitFor({ timeout: 60_000 });
        await c.move(addr(c));
      },
    },
    {
      id: "identity",
      vo: "The same passkey derives a second, private follower identity. It is a different address with nothing onchain linking it to the main one. Switching back returns the main address.",
      run: async (c) => {
        await c.scrollTo(main(c).getByText("Private follower identity"), 1200);
        await c.click(main(c).getByRole("button", { name: /Private identity/ }));
        await c.sleep(1500);
        await c.move(addr(c));
        await c.sleep(2500);
        await c.click(main(c).getByRole("button", { name: /Main account/ }));
        await c.move(addr(c));
      },
    },
    {
      id: "session",
      vo: "Small actions, like a manual sync or tightening limits, sign without a prompt for thirty minutes, from a session key kept only in this tab's memory. Withdrawals, following a new leader, raising limits or posting a bond always ask for the passkey again.",
      run: async (c) => {
        await c.scrollTo(main(c).getByText("Signing session"), 1500);
        await c.move(main(c).getByText(/Small actions \(manual sync/));
        await c.sleep(4000);
        await c.move(main(c).getByText(/always ask for your passkey again/));
      },
    },
    {
      id: "stateless",
      vo: "Copas stores no key. Clear every bit of local data, sign in again with the same passkey, and the same address comes back, rebuilt from the passkey.",
      run: async (c) => {
        await c.scrollTo(main(c).getByText("Stateless test"), 1200);
        const before = (await addr(c).textContent()).trim();
        await c.click(main(c).getByRole("button", { name: /Clear/ }));
        await c.page.waitForLoadState("load");
        await c.sleep(1500);
        await c.click(main(c).getByRole("button", { name: /Sign in with passkey/ }));
        await main(c).getByText(/^signed in$/).waitFor({ timeout: 60_000 });
        console.log(`  same address: ${before === (await addr(c).textContent()).trim()}`);
        await c.move(addr(c));
        await c.sleep(1000);
        await c.move(main(c).getByText(/Passed/).first());
      },
    },
    {
      id: "mobile",
      vo: "The same account works in the installable mobile app. On the trade screen, the same kind of passkey signs in, shows the wallet's AUSD balance, and then signs real Perpl orders, with the same session rules.",
      frames: "bounty-agora-mobile/funds",
    },
  ],
};
