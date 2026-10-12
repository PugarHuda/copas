# How Copas uses Nansen

Copas is bonded copy trading on Monad: leaders post an AUSD bond, declare a mandate, and followers copy their
Perpl perps positions through their own vaults. Nansen supplies the **onchain intelligence layer** that helps a
follower pick a leader (features D2 and D4 of `docs/SPEC.md`). Nansen data never triggers a trade. Execution is
done by deterministic contracts (`FollowerVault.sync`), and Nansen output is used only as **inputs to scores**.

Code: `copas/services/src/nansen.ts`. HTTP: `GET /discover`, `GET /leader/:addr/alignment`.

## Endpoints used

All calls are `POST https://api.nansen.ai/api/v1/<path>` with `chains: ["monad"]` / `chain: "monad"`.
Monad is in the chain enum of every endpoint below (checked against `https://api.nansen.ai/openapi.json`).

| # | Endpoint | Data category | Request | What Copas does with it | x402 price (Monad USDC) | Credits (API key) |
|---|---|---|---|---|---|---|
| 1 | `smart-money/netflow` | Smart Money, token flows | `{chains:["monad"], filters:{include_native_tokens:true, include_stablecoins:false}, pagination:{per_page:100}}` | **Smart-money alignment** (D2 b): for each Perpl market the leader holds (BTC, ETH, MON, SOL), we map to Monad tokens (WBTC/BTC, WETH, MON/WMON/LSTs, SOL) and read the *sign* of the 7d net flow. The score is the share of the leader's time-weighted exposure (last 7 days) that points the same way as smart money. | $0.05 | 5 |
| 2 | `smart-money/dex-trades` | Smart Money, DEX trades | `{chains:["monad"], pagination:{page, per_page:100}}`, up to 2 pages | **Leader discovery** (D2 a): we collect the set of Monad smart-money trader addresses and intersect it with active Perpl traders (Perpl leaderboard, volume > 0). Wallets in both sets are shown first, with a "Smart Money" flag. | $0.05 per page | 5 |
| 3 | `profiler/address/pnl-summary` | Profiler, wallet PnL | `{address, chain:"monad", date:{from,to}}` (30 days) | **Wallet quality** component of the composite score: the candidate's realized spot win rate and the sign of their realized PnL on Monad. | $0.01 | 1 |

Cost per decision (x402, Monad USDC):
- `/leader/:addr/alignment` makes 1 netflow call, so **$0.05**.
- `/discover?limit=10` makes 1 or 2 dex-trades pages plus 10 pnl-summary calls, so **$0.15 to $0.20**.

Every response carries `cost: { calls: [{endpoint, mode, usd | credits, paymentTx}], totalUsd, totalCredits }`.
The UI shows this as "this analysis cost $0.13" (D4: the agent pays for its own data).

## Payment modes

1. **API key.** Set `NANSEN_API_KEY`. We send the header `apikey: <key>` (security scheme `ApiKeyAuth` in the OpenAPI).
   Cost is read from `X-Nansen-Credits-Cost`.
2. **x402 on Monad (no account, no subscription).** Set `X402_PRIVATE_KEY` to a wallet holding USDC on Monad
   (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, `eip155:143`). We use `@x402/fetch` with
   `registerExactEvmScheme(client, { signer: viemAccount, networks: ["eip155:143"] })` from `@x402/evm`.
   - The first request gets back `402` with a base64 `payment-required` header. We read the Monad option's `amount`
     (6-decimal USDC) as the price.
   - The client signs an EIP-3009 authorization and retries with the **x402 V2 `PAYMENT-SIGNATURE` header**.
     Nansen rejects the V1 `X-PAYMENT` header, and a test checks we never send it.
   - The `payment-response` header gives the settlement tx hash, which we store in the cost ledger.
   - We don't use `nansen-cli` for payments: v2.0.1 has no Monad entry in its x402 token list.

`NANSEN_PAYMENT_MODE=apikey|x402` forces one mode. With neither key set, the routes return `503 { missing }`.

## MCP tools and CLI

The product does not call the MCP server or the CLI at runtime. We use the REST API directly so that x402 on
Monad works. Equivalent CLI commands, which we used during development to explore the data:

```
nansen research smart-money netflow --chain monad --limit 20
nansen research smart-money dex-trades --chain monad
```

Profiler PnL summary is called through REST only. Check the exact CLI subcommand with `nansen schema` before
quoting it in the submission. Equivalent MCP tools: `smart_traders_and_funds_netflow` and
`smart_traders_and_funds_dex_trades`.

## What we show (redistribution rules)

We follow Nansen's MCP Data Redistribution Guidelines:
- **We never show raw smart-money holdings or flow amounts.** The alignment output contains only, per market,
  the leader's direction, the smart-money direction (`inflow` / `outflow` / `none`) and `agrees: true/false`,
  plus one 0–100 score and a coverage ratio. A unit test checks that no flow figure leaks into the output.
- Discovery returns smart-money addresses only when they are also Perpl traders. It shows each as a boolean
  `smartMoney` flag, never with their trades or labels.
- The composite score (0–100) mixes Perpl performance (40%), risk (30%), smart-money alignment (20%) and Nansen
  wallet quality (10%). Missing components are dropped and the weights are renormalized.
- Every score carries `poweredBy: "Powered by Nansen"`, and the UI shows that label.

## Limits we tell users about

- Nansen covers mainnet only. Signals refer to Monad mainnet (chain 143), even when a demo trade runs on testnet.
- Monad label coverage is new and may be thin. If netflow has no row for a market, that market counts as
  "no data" and lowers `coverage`. It never counts as agreement or disagreement.
- Smart-money spot flow on Monad is a proxy for the direction of a perps position. It is context, not a signal
  to trade.

## Live status (12 Oct 2026)

- Production runs in API-key mode. The key's 100 credits are used up, so every Nansen call answers `403 insufficient_credits`.
  `/discover` still ranks Perpl traders by performance and risk (no smart-money flag, `poweredBy: null`), and
  `/alignment` returns `score: null` with `unavailable: "nansen-credits"`. No Nansen-derived number is shown.
- x402 needs no credits, but Nansen's 402 only lists **mainnet** networks: Base, Monad (`eip155:143`), Solana,
  XLayer and BSC. There is no testnet option and no free endpoint. To turn it on, fund a fresh key with about
  1 USDC on Monad mainnet (`0x7547…b603`), then on the `copas-services` project set `X402_PRIVATE_KEY=<key>` and
  `NANSEN_PAYMENT_MODE=x402` and redeploy. One `/discover?limit=10` costs $0.15 to $0.20 and `/alignment` costs $0.05.
