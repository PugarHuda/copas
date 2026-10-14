import type { Metadata } from "next";
import Link from "next/link";
import { Panel } from "@/components/ui";
import { deployment } from "@/lib/copas/contracts";

export const metadata: Metadata = { title: "Docs" };

const REPO = "https://github.com/PugarHuda/copas/blob/master";
const ext = (href: string, label: string) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
    {label}
  </a>
);

const FLOW = [
  ["1. Leader bonds", "A leader creates a LeaderBook, deposits AUSD into its own Perpl account, posts an AUSD bond and declares a mandate: max drawdown per epoch, max leverage, max notional, allowed markets, performance fee. Mandate changes only take effect from the next epoch."],
  ["2. Follower copies", "A follower signs in with a Mera passkey, creates a FollowerVault they own (it holds its own Perpl account) and follows with their own caps: ratio, max leverage, max notional, price band, stop-loss. Anyone may call sync(), but it can only move the vault toward ratio × the leader's live Perpl position, inside those caps."],
  ["3. Checkpoints", "Each checkpoint reads the leader's equity straight from Perpl state in the same block (no oracle) and updates the unit price and high-water mark. Fees are taken only above each follower's own high-water mark."],
  ["4. Breach", "If drawdown passes the mandate, the same checkpoint flags the breach, slashes the bond and fee escrow into a pot, and follower vaults unwind. Each follower claims its real loss from the pot, paid to its own wallet. No vote, no admin key."],
  ["5. Consent", "If a leader loosens its mandate, vaults stop copying until their owner accepts the new terms; the fee is always the lower of the live and the accepted fee."],
];

const PAGES = [
  ["/", "Bonded leaderboard"],
  ["/leader/<book>", "Mandate, bond, drawdown, positions, AI risk analysis (Kimi K3, signed), Nansen alignment, checkpoints and breaches"],
  ["/follow/<book>", "Follow ticket with your own caps"],
  ["/me", "Your vaults, copied positions, claims, mandate consent, Dynamic guard"],
  ["/trade", "Mobile trading app: passkey account, AUSD, Perpl orders gated by your own mandate"],
  ["/market/<book>", "Kuru DOWN market for a leader (bet on or hedge a breach)"],
  ["/proof", "Recompute a breach from Perpl state; Privy policy DENY log"],
  ["/analytics", "Perpl risk dashboard (Envio): liquidations, funding, OI, cohorts, oracle cross-check"],
  ["/seasons", "Leaders ranked by what followers took home"],
  ["/become-leader", "Post a bond and a mandate (imports a Hyperliquid track record)"],
  ["/underwrite", "Add AUSD to a leader's protection pool"],
  ["/saved", "Live Perpl losses vs what a Copas bond would have returned"],
];

const STACK = [
  ["Perpl", "Contracts hold Perpl accounts and trade via execOrder; keeper copies longs and shorts; REST data for analytics"],
  ["Kuru", "Per-leader DOWN tokens (a CDS on a trader) listed on Kuru order books, quoted by our market maker"],
  ["Mera", "Passkey is the whole account layer; a second PRF key encrypts leader notes for followers only"],
  ["Agora (AUSD)", "Collateral everywhere; supply, peg and reserves cross-checked live on /trade"],
  ["Privy", "Keeper server wallet with ALLOW/DENY policy and gas sponsorship"],
  ["Dynamic", "MPC operator wallets behind a Copas allowlist, email wallets, unfollow-only delegated guard"],
  ["Envio", "HyperIndex over every Perpl event + Copas contracts; HyperSync for Kuru fills"],
  ["Chainlink CRE", "Risk-guardian workflow that can checkpoint risky leaders"],
  ["Aurora Intents", "Any-chain deposit to USDC on Monad"],
  ["Nansen", "Leader discovery and smart-money alignment, paid per call with x402"],
  ["Kimi", "Signed AI risk analyst: AI explains, the contract enforces"],
  ["Alchemy", "Primary Monad RPC + Notify webhook to Telegram alerts"],
  ["MetaMask", "mm copas Agent Wallet plugin with mandatory risk limits"],
];

export default function DocsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="micro text-ink-3">Docs</p>
        <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">How Copas works</h1>
        <p className="max-w-3xl text-sm text-ink-2">
          Copas is bonded copy trading on Monad. Leaders put an AUSD bond and an onchain mandate behind their trading; followers copy their Perpl positions through a vault
          they own; a breach slashes the bond to the followers. Everything below runs on Monad testnet (chain 10143).
        </p>
      </header>

      <Panel title="The mechanism">
        <ol className="space-y-3 text-sm">
          {FLOW.map(([h, b]) => (
            <li key={h}>
              <div className="font-medium text-ink">{h}</div>
              <p className="text-ink-2">{b}</p>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Try it">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
            <li>Create a passkey account from the account menu (needs a passkey manager with PRF: Windows Hello, iCloud Keychain, Google Password Manager, 1Password).</li>
            <li>Account menu → Get testnet MON + AUSD.</li>
            <li>Open a leader, follow it (first vault deposit is exactly 100 AUSD, Perpl&apos;s account minimum), then watch the copy in <Link href="/me" className="underline">My vault</Link>.</li>
            <li>Or trade on your phone at <Link href="/trade" className="underline">/trade</Link>.</li>
          </ol>
        </Panel>
        <Panel title="Design rules">
          <ul className="list-disc space-y-2 pl-5 text-sm text-ink-2">
            <li>The backend never holds follower funds; withdrawals only go to the vault owner.</li>
            <li>Copy-only: sync() has no discretion beyond ratio × leader position inside your caps.</li>
            <li>No oracle in money logic: equity, drawdown, breach and settlement come from Perpl views in the same block.</li>
            <li>AI explains, rules execute: Kimi K3 writes the risk analysis (signed), contracts decide.</li>
            <li>Honest risk: max protection = bond / follower capital is always shown.</li>
          </ul>
        </Panel>
      </div>

      <Panel title="Pages" pad={false}>
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <tbody>
              {PAGES.map(([p, d]) => (
                <tr key={p}>
                  <td className="num whitespace-nowrap text-ink">{p}</td>
                  <td className="text-ink-2">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Built with" pad={false}>
        <div className="overflow-x-auto">
          <table className="data w-full text-sm">
            <tbody>
              {STACK.map(([s, d]) => (
                <tr key={s}>
                  <td className="whitespace-nowrap font-medium text-ink">{s}</td>
                  <td className="text-ink-2">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="For developers and agents">
        <ul className="list-disc space-y-2 pl-5 text-sm text-ink-2">
          <li>Contracts (verified on Sourcify Monad): registry <span className="num">{deployment?.registry}</span> — addresses in {ext(`${REPO}/contracts/deployments/10143.json`, "deployments/10143.json")}, security review in {ext(`${REPO}/contracts/SECURITY.md`, "SECURITY.md")}.</li>
          <li>MCP server for AI agents (13 read-only tools): <span className="num">https://copas-services.vercel.app/mcp</span></li>
          <li>MetaMask Agent Wallet plugin: {ext(`${REPO}/plugin/skills/copas/SKILL.md`, "mm copas SKILL.md")}</li>
          <li>Telegram bot with breach / epoch / claim alerts: {ext("https://t.me/copas_monad_bot", "@copas_monad_bot")}</li>
          <li>Full spec, status and evidence: {ext(`${REPO}/docs/SPEC.md`, "SPEC")}, {ext(`${REPO}/docs/STATUS.md`, "STATUS")}, {ext(`${REPO}/docs/SUBMISSION.md`, "SUBMISSION")}, {ext(`${REPO}/docs/KIMI.md`, "KIMI")}.</li>
          <li>Source: {ext("https://github.com/PugarHuda/copas", "github.com/PugarHuda/copas")}</li>
        </ul>
      </Panel>
    </div>
  );
}
