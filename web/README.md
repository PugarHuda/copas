# Copas web

Next.js 15 (App Router) + TypeScript + Tailwind v4, wagmi v2 + viem, pnpm. Dark-first, ID/EN.

```bash
pnpm install
cp .env.example .env.local   # optional, every var has a default
pnpm dev                     # http://localhost:3000
pnpm build && pnpm start
pnpm check                   # assert checks: trade stats + breach/slash math
```

`predev`/`prebuild` run `scripts/sync-contracts.mjs`, which copies `../abis/*.json` and
`../contracts/deployments/<chainId>.json` into `lib/copas/generated/`. When a deployment file
exists for `NEXT_PUBLIC_COPAS_CHAIN_ID`, leader pages switch from mock data to onchain reads.

## Structure

| Path | What |
| --- | --- |
| `app/page.tsx` | Bonded-leader leaderboard + Shadow leaders tab (Perpl leaderboard) |
| `app/analytics/**` | Perpl analytics/risk dashboard: protocol, wallet profile, compare |
| `app/leader/[addr]`, `app/follow/[addr]` | Leader profile, follow ticket |
| `app/me`, `app/become-leader`, `app/underwrite`, `app/market/[leader]` | Follower vault, leader onboarding, underwriting, DOWN market |
| `app/proof` | Contract addresses, breaches/slashes, reproducible math (`Recompute.tsx`, live equity via server action) |
| `app/settings` | Passkey account, signing session, stateless test, language |
| `app/api/perpl/[...path]` | Allow-listed cached proxy for Perpl public REST (CORS) |
| `app/api/analytics/protocol` | Protocol snapshot JSON |
| `app/api/services/[...path]` | Proxy to `copas/services` (backtest, AI analysis, simulate) |
| `lib/perpl/` | Perpl REST client, onchain reads, log scans, trade stats, Envio adapter |
| `lib/copas/` | Copas contract config, reads, writes (`useCopasWrite`), breach math |
| `lib/mera/` | Mera passkey provider + `useMeraSession` (create / sign in / session / `authorize(risk)`) |
| `lib/mock/copas.ts` | Mock leaders/vaults/proof. Marked `// MOCK until contracts deployed` |
| `lib/i18n/` | Dictionary i18n, default `id`, cookie toggle in the header |

## Real vs mock

Real:
- `/analytics`: volume (24h/7d/30d/all), OI, TVL (onchain), fee balance, active traders, per-market
  breakdown, long/short skew, funding history, liquidations and deposit/withdrawal flows (exchange
  logs, last `FLOWS_SCAN_DAYS` days), top traders.
- `/analytics/wallet/[addr]`: open positions with liq price, equity curve (~5 days of historical
  state), trades and stats (log scan of the last `TRADE_SCAN_HOURS` hours, or full history from
  Envio when `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` is set), flows, leaderboard ranks. Compare page too.
- Shadow leaders tab: `GET app.perpl.xyz/api/v1/trading/leaderboard/:period/:sorting`.
- Passkey login via `@category-labs/mera` (PRF -> HKDF -> secp256k1). Works in the browser; no adapter fallback needed.
- `/proof` recompute: the live equity input reads Perpl onchain.

Mock until Copas contracts are deployed: bonded leaders, mandates, follower vaults, underwriting,
DOWN market, breaches, Privy DENY log, Kimi signatures. Every mock surface shows an amber
source dot; live ones show green.

## Data-source limits

- Public Monad RPCs cap `eth_getLogs`: rpc2.monad.xyz allows 10k blocks, the others 100
  (checked 11 Oct 2026). Log scans run in 10k-block chunks, 8 in flight, with 429 backoff.
  7 days of flows is ~150 requests (~8s cold, cached 120s). Longer history needs Envio.
- Historical state (equity/TVL curves) is limited to ~130h by the public RPC.
- Fees are estimated from volume x base-tier rates; Perpl exposes no fee endpoint.

## Passkeys

PRF is required. Chrome passkeys stored in a local profile often lack PRF; use a synced passkey
(Google Password Manager, iCloud Keychain, 1Password, Windows Hello). `NEXT_PUBLIC_MERA_RP_ID`
must match the domain passkeys were created on; it defaults to the current hostname.
