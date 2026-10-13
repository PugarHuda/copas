# @copas/services

AI & data services for Copas: leader data, backtest, LLM risk analyst (OpenRouter free models; Kimi K3 path kept),
Nansen discovery, transaction simulation, track-record attestation, and an x402 pay-per-call report.
**Hosted:** https://copas-services.vercel.app (project `copas-services`, `vercel deploy --prod --yes` from this folder). It works as a TypeScript library (`import { backtest } from "@copas/services"`) and
as a small Hono HTTP server.

AI explains and never executes (SPEC §1 principle 5). Every number comes from deterministic code. Kimi only
phrases it, and the guard in `kimi.ts` overwrites any flag or reason the model makes up.

```
pnpm install
cp .env.example .env     # all keys optional
pnpm test                # vitest, fixtures only, no network
pnpm build               # tsc -> dist/
pnpm dev                 # http://localhost:8787
pnpm fixtures            # re-record public fixtures (Perpl, plumb, Nansen 402)
```

From the web app: add `"@copas/services": "file:../services"`, run `pnpm build` here, and call the functions from
route handlers (server only, because the module reads env keys).

## HTTP

| Route | Module | Keys | Returns |
|---|---|---|---|
| `GET /leader/:addr/stats?days=30[&fills=1]` | leaderData | none | official 30d row, capital estimate, closed trades, realized equity curve, stats |
| `POST /leader/:addr/backtest` body `{follower?, mandate?, opts?, days?}` | backtest (C3) | none | follower equity curve, max DD, fees, slippage, epochs breached, compensation, assumptions |
| `GET /leader/:addr/analysis` | features + kimi.ts (D1, D3) | `OPENROUTER_API_KEY` (or `KIMI_API_KEY`) | `{analysis, features, signature, signatureValid, nonce, verifyUrl, costUsd, inputHash, outputHash, model}`. On OpenRouter `signature` is an EIP-191 receipt signed by `ATTESTER_PRIVATE_KEY` over `{leader, model, generationId, inputHash, outputHash, at}` |
| `GET /leader/:addr/alignment?days=7` | nansen (D2) | `NANSEN_API_KEY` or `X402_PRIVATE_KEY` | alignment score, composite score, cost ledger |
| `GET /discover?limit=10` | nansen (D2, D4) | same | candidate leaders with composite scores, cost ledger |
| `POST /simulate` body `{from,to,data,value?,chainId?}` | simulate (C4) | Tenderly optional | balance changes and decoded events |
| `GET /attest/:addr` | attest (A7) | `ATTESTER_PRIVATE_KEY` | record, canonical JSON, keccak hash, EIP-191 signature, attester |
| `GET /oracle/check?chain=143\|10143&block=N` | oracle | none | Perpl mark vs Pyth / Chainlink / Supra read onchain, now or at a past block, see section 9 |
| `GET /leader/:book/oracle` | oracle | `ENVIO_GRAPHQL_URL` | the oracle check at each breach block (and the latest checkpoint) of a Copas LeaderBook |
| `POST /mcp` | mcp | none | Model Context Protocol (Streamable HTTP, stateless): 13 read-only tools, see section 8 |
| `GET /x402/report/:addr` | x402seller (D4) | `X402_PAY_TO` | 402 until paid 0.01 testnet USDC on Monad (`eip155:10143`, USDC `0x534b…43A3`), settled by the Monad facilitator `x402-facilitator.molandak.org`; then `{attestation, analysis, paidWith}` |

When a key is missing, the route returns `503 {error, missing}`. `/analysis` also returns the deterministic
`features` in that case, so the UI can still show the numbers.

## Modules

### 1. Leader data (`leaderData.ts`)
- **Official 30d PnL, ROI and volume:** `GET https://app.perpl.xyz/api/v1/trading/leaderboard/:period/:sorting`.
  This is public and was found in the app bundle. ROI is in 1/100 % and the denominator is
  `max(100, starting equity + inbound transfers)`, so `capitalEstimate = pnl / roi`.
- **Fills:** Perpl's REST fill/position/portfolio endpoints (`/v1/trading/fills`, `position-history`,
  `portfolio/:kind/:period`, …) need an Ed25519 API key enrolled by *that* wallet. We checked with curl:
  `401` for anyone else. So the source for arbitrary leaders is an indexer:
  - **Envio** (`copas/indexer`, entity `Fill` in `schema.graphql`) when `ENVIO_GRAPHQL_URL` is set.
    `Fill` has no position size, so `positionAfter` is a running sum inside the window.
  - Otherwise **plumb** (`https://plumb.huginn.tech/api/v1/wallets/:addr/trades`). This is a public third-party
    Perpl indexer that gives every position change with its fill, fee, realized PnL and remaining size.
- Output: normalized `Fill[]`, round-trip `ClosedTrade[]` (inverts split into two trips), realized equity curve,
  and stats (win rate, PF, max DD, hold, leverage, market mix, streaks).

### 2. Backtest (`backtest.ts`, C3)
A deterministic replay of the leader's fills through the Copas rules. It mirrors `LeaderBook.sol` (unit price,
epoch HWM, checkpoint after each trade, DD/leverage breach, mandate rejection, `pot = bond + feeEscrow`,
`claim = min(pot × cap / capTotal, loss)`) and `FollowerVault.sol` (`sync` target, reduce/flip first, `maxChase`,
IOC price band, notional cap, margin, stop-loss pause, performance fee on HWM at the epoch touch). Fees are taker
3.45 bp on each side. Slippage = half-spread + 1–3 blocks × drift. Every result carries an `assumptions[]`
list that the UI must show.

### 3. LLM risk analyst and challenger (`features.ts`, `kimi.ts`, D1, D3)
- `computeFeatures` (pure code): style label, tilt (size-ups ≥ 1.5× after a loss, re-entry within 1h, daily
  frequency spikes > mean + 2σ), style drift (last 7d vs history: market-mix TVD, leverage, size, frequency, new
  markets), weekly summary, and ranked candidates for "reasons not to follow". Each candidate has a metric and a value.
- **Production runs on OpenRouter free models** (`OPENROUTER_API_KEY`; `LLM_MODEL` = comma list used as a fallback
  chain, default `google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free`), cost $0. OpenRouter signs
  nothing, so the service signs a receipt: `keccak256(canonicalJson({leader, model, generationId, inputHash,
  outputHash, at}))`, EIP-191 by `ATTESTER_PRIVATE_KEY` (same signer as `/attest`). Verify with
  `viem.verifyMessage({address: signer, message:{raw: hash}, signature})`. Text is English only (`id` = `en`).
  The free tier allows 50 requests a day per OpenRouter account; past that the route answers 502 `openrouter 429`
  until 00:00 UTC (the CDN keeps already-analysed leaders for 1 h).
- D3 "challenger" = `devilsAdvocate`: 3 reasons not to follow, picked from the deterministic candidate ranking.
- Kimi path (kept, not used in production): `kimi-k3`, `reasoning_effort:"high"`, `response_format: json_object`, no `temperature`.
  Each call sends `X-Msh-Request-Nonce: <uuid>` and reads `Msh-Request-Timestamp` / `Msh-Request-Signature`.
  The signature is verified right away at `POST /v1/signatures/verify`. All text fields are bilingual `{en, id}`.
  Cost = (uncached input × $3 + cached × $0.30 + output × $15) / 1M.
  Each call appends `{nonce, signature, inputHash, outputHash, usage, costUsd}` to `data/kimi-log.jsonl`.
- Guard: `tilt.detected` and `drift.detected` are forced to equal the computed flags. Devil's-advocate items must
  use keys from the candidate list. Invented keys are dropped and the list is topped up from the deterministic
  ranking.

### 4. Nansen discovery (`nansen.ts`, D2, D4)
See [NANSEN.md](./NANSEN.md) for every endpoint, data category, payment mode and redistribution rule.

### 5. Simulation (`simulate.ts`, C4)
- With `TENDERLY_ACCESS_KEY` / `TENDERLY_ACCOUNT` / `TENDERLY_PROJECT` set, it uses the Tenderly Simulation API
  (`network_id` 143 or 10143; Tenderly's public network list includes both).
- Production has no Tenderly account configured, so the live engine is the fallback below.
- Otherwise it calls **`eth_simulateV1`** on `rpc.monad.xyz` (`testnet-rpc.monad.xyz` for `chainId: 10143`) through viem `simulateCalls({traceAssetChanges:true})`.
  This returns ERC-20/native balance diffs of `from` plus events decoded with `copas/abis/*.json`.
- Tested live: an AUSD transfer from an EOA returned the diff and a decoded `Transfer` event.
- Monad limits on the fallback:
  - The sender must be an EOA ("sender not eoa").
  - No `gasUsed`: Monad's `eth_simulateV1` reports the call gas limit, not gas used.

### 6. Track-record attestation (`attest.ts`, A7)
- `buildTrackRecord` builds the record: PnL 30d (official leaderboard), all-time realized net PnL over fetched
  fills, max DD (AUSD and % of the ROI base), win rate, closed trades, first/last trade, `complete` flag, sources.
- `canonicalJson` sorts keys and writes amounts as fixed 6-decimal strings.
- The record is hashed with `keccak256` and signed with EIP-191 `signMessage({message:{raw: hash}})` by
  `ATTESTER_PRIVATE_KEY`.
- To verify: `verifyAttestation(a)`, or in the browser
  `viem.verifyMessage({address: attester, message:{raw: hash}, signature})`.
- The label "offchain attested" is part of the response.

### 7. x402 pay-per-call report (`x402seller.ts`, D4 seller side)
`GET /x402/report/:addr` sits behind `@x402/hono` `paymentMiddleware`: 0.01 testnet USDC on Monad testnet
(`eip155:10143`, USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`, EIP-712 domain `USDC`/`2`), paid to `X402_PAY_TO`
(production: the attester `0x6dbB…2aa1`). The Monad facilitator `https://x402-facilitator.molandak.org` verifies the
EIP-3009 authorization and settles it, paying the gas. Both parts of the report are required: if the attestation or the analysis fails (e.g. OpenRouter 429), the
route answers `503` with `Retry-After: 3600` and `failed[]`, and `@x402/hono` cancels instead of settling (it settles
only responses below 400), so the buyer is not charged. A 200 always has `attestation` (record, hash, signature) and
`analysis` (text, features, receipt). Payer script:
`X402_PAYER_KEY=0x.. pnpm exec tsx scripts/x402-pay.ts [base] [leader]` prints the `payment-response` settlement tx.
Live, 12 Oct: a real payment settled against production, tx `0x5d9c18d9819552d7979f5fc6819b2ead3a4da01471056ac5463729864e20e1f5`, submitted by the facilitator
`0x7f6a…Db86` (0.01 USDC from the deployer to the attester). Testnet USDC for the payer came from selling 0.8 MON on
Kuru's testnet MON/USDC book `0x1f57a841540fe23c2989387c18f2cb1335cbae92` (`placeAndExecuteMarketSell`, native MON).

### 8. MCP server for AI agents (`mcp.ts`)
`https://copas-services.vercel.app/mcp` is a Model Context Protocol endpoint (`@modelcontextprotocol/sdk`
`WebStandardStreamableHTTPServerTransport`, stateless, JSON responses, `Cache-Control: no-store`), so any MCP client
(Claude, Cursor, a MetaMask agent running next to the `mm copas` plugin) can research a leader and read Copas state
before it acts. Every tool is read-only (`readOnlyHint`); none takes or holds a key. Writes stay in the plugin's
`walletExecutor` with its risk limits.

| Tool | Source |
|---|---|
| `copas_protocol` | CopasRegistry on Monad testnet: factories, leader count, markets, bond ratio, deposit cap, fee splits |
| `copas_list_leaders` | every LeaderBook from `registry.leaderBooks(i)` with status, epoch, mandate, bond, protection, equity, unit price, capacity |
| `copas_get_leader` | one LeaderBook (refused unless `registry.isLeaderBook`): owner/operator, current + pending mandate, bond vs min bond, fee escrow, pool |
| `copas_get_vault` | one FollowerVault (refused unless `registry.isVault`): followed leader, copy params, accepted mandate + `consentOk`, equity, HWM |
| `copas_get_owner` | `registry.vaultsOf` / `leadersOf` for a wallet |
| `perpl_leader_stats`, `perpl_backtest`, `perpl_leader_analysis`, `perpl_leader_alignment`, `perpl_discover_leaders`, `perpl_attest_track_record`, `monad_simulate_tx`, `oracle_check` | the HTTP routes above, run in-process (`app.request`), so answers and errors match the API exactly |

Onchain reads are one Multicall3 call per object through viem (`MONAD_TESTNET_RPC_URL` or the public RPC). Only the
registry address is fixed (`contracts/deployments/10143.json`); factories, leader books and vaults are read from it.

```
npx @modelcontextprotocol/inspector --cli https://copas-services.vercel.app/mcp --method tools/list
npx @modelcontextprotocol/inspector --cli https://copas-services.vercel.app/mcp --method tools/call --tool-name copas_list_leaders
claude mcp add --transport http copas https://copas-services.vercel.app/mcp
```

### 9. Oracle cross-check of Perpl marks (`oracle.ts`)
Perpl prices every market against its own Chainlink Data Streams reference (`PerpetualInfo.linkFeedId`, `oraclePNS`).
`oracleCheck` compares the Perpl mark with oracles Perpl does not use, all read onchain in one Multicall3 call
(block time from `getCurrentBlockTimestamp`, so ages are exact even at a past block; the Monad RPC serves archive state):

| Chain | Pyth `0x2880aB15…7B43` `getPriceUnsafe` | Chainlink Data Feeds `latestRoundData` | Supra push `getSvalue` |
|---|---|---|---|
| 143 | BTC, ETH, SOL, MON, HYPE (sponsored push feeds, 1h heartbeat, seconds old in practice) | BTC, ETH, MON | none (no BTC/ETH pair on mainnet) |
| 10143 | read, but nobody pushes on testnet: hours to days old, so shown and marked stale | BTC, ETH | BTC_USD, ETH_USD, SOL_USDT (`0xf0e852BC…33F6`) |

Addresses come from docs.monad.xyz/tooling-and-infra/oracles and github.com/monad-crypto/protocols. Per market it
returns each source's price, Pyth confidence, publish time, age, freshness (<= 1 h) and deviation in bps; the
reference is the median of fresh sources; `status` is ok (< 30 bps), watch, spike (>= 100 bps) or no_fresh_oracle
(ZEC, LIT, VVV, PUMP, NEAR on mainnet and MON on testnet have no fresh feed). Chainlink is flagged
`independent: false` because Perpl's own reference is Chainlink. Pyth's Hermes HTTP API now answers 401 without a
key, so only onchain Pyth is used. `/leader/:book/oracle` reads the leader's Breach and Checkpoint rows from Envio
(one query) and runs the check at each breaching checkpoint's block, so a follower can tell whether a breach came
from a market-wide move or a Perpl-only price dislocation. Live: the testnet drawdown breach of LeaderBook
`0xb1b0…5208` at block 70287540 had every covered Perpl mark within 2.5 bps of the oracles.

## Tests
`test/services.test.ts` (44 tests) runs against `test/fixtures`. One test calls the live facilitator's `/supported`
(x402 seller 402 shape); everything else is offline:
- Real recordings: Perpl leaderboard, plumb fills of leader `0xedcd…409b`, plumb wallet, live Nansen 402.
- Synthetic files, marked `_note`, shaped from the official schemas: Nansen 200s, Kimi completion, Tenderly.
- Real `@x402/fetch` payment flow against the recorded 402. It checks the `PAYMENT-SIGNATURE` V2 payload on
  `eip155:143` and that `X-PAYMENT` is never sent.
- Exact contract math cases: a breach paying `min(pro-rata, loss)`, fees on both sides, chase/band/cap.
- Determinism and claim invariants on the real leader.
- Envio GraphQL source.
- 503s, and LLM guard overrides.
- EIP-191 analysis receipt verifies against its signer.
- MCP: tool list (all read-only, `no-store`), data tools equal the HTTP routes, `copas_get_leader` decoded from a stubbed Multicall3.

Not covered by tests: the `eth_simulateV1` fallback (checked live only) and real Kimi/Nansen responses (no keys
yet). Run `pnpm fixtures` after adding keys to extend the recordings.
- Oracle cross-check: median of fresh sources, stale Pyth excluded, spike detection, `/leader/:book/oracle` per breach block, `oracle_check` equals the routes (stubbed Multicall3 with live-read values).
