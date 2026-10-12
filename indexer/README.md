# Copas indexer (Envio HyperIndex v3)

Indexes the **Perpl Exchange** on Monad (fills, positions, liquidations, collateral, funding) into
analytics entities for the Perpl dashboard (G2), leader stats/backtests (A7, C3) and execution proof (C7),
plus the **Copas** contracts (registry, LeaderBook, FollowerVault, UnderwriterPool, BreachMarket,
AgentLeaderRegistry). Spec: `../docs/SPEC.md` G1.

| | |
|---|---|
| Envio | `envio@3.12.1` (v3 syntax: `chains`, `indexer.onEvent`, `indexer.contractRegister`, ESM) |
| Node | >= 22 |
| Chains | Monad mainnet `143`, Monad testnet `10143` (rows are per chain) |
| Perpl Exchange | mainnet `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` (proxy), testnet `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Mainnet start block | **54,773,010**, the first Perpl Exchange log (found with HyperSync). |
| Testnet start block | **70,084,000** (11 Oct 2026, just before the Copas testnet deploy at 70,102,394). Full testnet Perpl history would take ~74 h on the free HyperSync tier, so earlier testnet perps are skipped (see Known limits). |
| Hosted | Envio Cloud, https://indexer.dev.hyperindex.xyz/042db7d/v1/graphql. On 12 Oct 2026 both chains were at head: 72.5M mainnet events, 5,288 traders, 36.2M fills, 3,661 liquidations. |

## Files

- `config.yaml` – contracts, events, chains. Perpl V1 **and** V2 events are listed (different topic0).
- `schema.graphql` – entities (units documented at the top: money = AUSD CNS, 6 decimals).
- `src/handlers/PerplExchange.ts`, `src/perpl.ts` – Perpl handlers + helpers.
- `src/handlers/Copas.ts` – Copas handlers, dynamic registration from `CopasRegistry`.
- `test/*.test.ts` – vitest with `createTestIndexer()` simulated events (no network needed).
- `abis/` – copies of `../abis/*.json` (`pnpm abis` refreshes them).

## Run locally

Envio ships no Windows binary: on Windows run everything inside **WSL** (Ubuntu + Node 22 + pnpm).
`pnpm dev` also needs Docker (Postgres + Hasura).

```bash
cp .env.example .env          # put ENVIO_API_TOKEN (https://envio.dev/app/api-tokens)
pnpm install
pnpm codegen                  # after any change to config.yaml / schema.graphql
pnpm typecheck
pnpm test                     # vitest, simulated events
pnpm dev                      # sync + GraphQL at http://localhost:8080 (Hasura, password: testing)
```

`ENVIO_API_TOKEN` is **required**: Monad HyperSync/HyperRPC answer "Your token is malformed" without it
(checked 3 Oct 2026). The public Monad RPC caps `eth_getLogs` at 100 blocks, so an RPC-only sync from
February is not practical.

### Env vars

| Var | Purpose |
|---|---|
| `ENVIO_API_TOKEN` | HyperSync token (required) |
| `ENVIO_COPAS_REGISTRY_{143,10143}` | CopasRegistry address (LeaderBook/FollowerVault/UnderwriterPool are discovered from it) |
| `ENVIO_COPAS_BREACH_MARKET_{143,10143}` | BreachMarket address |
| `ENVIO_COPAS_AGENT_REGISTRY_{143,10143}` | AgentLeaderRegistry address |

Unset Copas vars default to the zero address (nothing indexed). The hosted indexer has the testnet
addresses from `contracts/deployments/10143.json` set (registry `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d`);
mainnet Copas is not deployed, so the `_143` vars are unset.

## Deploy to Envio Cloud

1. Push the repo to GitHub, install the Envio GitHub App, add the indexer at https://envio.dev/app
   (root directory `copas/indexer`, config `config.yaml`, branch `main`), or with the CLI:
   ```bash
   npx envio-cloud login
   npx envio-cloud indexer add --name copas --repo <org>/<repo> --branch main
   npx envio-cloud indexer settings set copas   # root dir copas/indexer
   npx envio-cloud indexer env set copas ENVIO_API_TOKEN=... ENVIO_COPAS_REGISTRY_143=0x...
   ```
2. Auto-deploy on push is **off** for this project (a redeploy resyncs 72M mainnet events). Deploy a commit by hand
   from the Envio dashboard, wait until both chains reach head, then point `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` (web) and
   the services at the new endpoint. `npx envio-cloud deployment endpoint copas <commit>` prints the GraphQL URL.
3. Env var keys must start with `ENVIO_`.

## What is indexed

Perpl events: `AccountCreated`, `CollateralDeposit`, `CollateralWithdrawal`, `IncreasePositionCollateral`,
`PositionCollateralDecreased`, `MakerOrderFilled(V2)`, `TakerOrderFilled(V2)`, `PositionOpened(V2)`,
`PositionIncreased(V2)`, `PositionDecreased`, `PositionClosed`, `PositionInverted`, `PositionLiquidated`,
`PositionDeleveraged(V2)`, `PositionUnwound(V2)`, `PositionUnwoundWithoutPayment(V2)`,
`FundingEventCompleted`, `ContractAdded(V2)`.

How fills are attributed: Perpl emits `OrderRequest -> [maker Position* -> MakerOrderFilled]* -> taker
Position* -> TakerOrderFilled` (checked on mainnet txs). `TakerOrderFilled` has no `perpId/accountId`, so a
one-row `TxCursor` remembers the last position event of the tx. Volume and trade counts come from maker
fills only (one per match, same as DefiLlama); fees are counted on both sides (`feeCNS` already includes
the position `insFee + protFee`).

Entities: `Protocol`, `Market`, `Account`, `Position`, `ClosedTrade`, `Trade`, `Fill`, `Liquidation`,
`CollateralFlow`, `FundingEvent`, `ProtocolDaily`, `MarketDaily`, `AccountDaily`; Copas: `Leader`, `Epoch`,
`Checkpoint`, `Breach`, `Vault`, `Follower`, `CopyFill`, `Claim`, `UnderwriterPosition`, `BreachSeries`.

## What the web reads

| Page / panel | Entities |
|---|---|
| `/analytics` flows, liquidations, TVL proxy | `CollateralFlow`, `ProtocolDaily`, `Liquidation` |
| `/analytics` funding heatmap (30 d), OI by market (90 d) | `MarketDaily` (`sumFundingRatePct100k / fundingEvents` = daily average rate) |
| `/analytics` trader cohorts | `Account` (every mainnet trader, paged) |
| `/analytics/wallet/[addr]` trades, equity curve | `ClosedTrade`, `AccountDaily`, `CollateralFlow` |
| leader page, `/proof`, `/seasons`, landing counters | `Checkpoint`, `Breach`, `Claim`, `Leader`, `Vault`, `Follower`, `CopyFill`, `Fill`, `UnderwriterPosition` |

## Example GraphQL queries

Protocol volume time series (last 30 days):

```graphql
query ProtocolSeries($since: Int!) {
  ProtocolDaily(where: { date: { _gte: $since } }, order_by: { date: asc }) {
    date volumeCNS longVolumeCNS shortVolumeCNS feesCNS trades uniqueTraders
    depositsCNS withdrawalsCNS netFlowCNS liquidations openInterestCNS
  }
  Protocol { volumeCNS feesCNS netFlowCNS openInterestCNS traders accounts }
}
```

Per-market skew and funding:

```graphql
query Markets {
  Market(order_by: { volumeCNS: desc }) {
    symbol lastPricePNS priceDecimals lotDecimals longOpenInterestLNS shortOpenInterestLNS
    openInterestCNS volumeCNS lastFundingRatePct100k
    daily(order_by: { date: desc }, limit: 30) { date volumeCNS longVolumeCNS shortVolumeCNS closePricePNS }
  }
}
```

Wallet profile (address -> Perpl account, positions, history, equity curve):

```graphql
query Wallet($address: String!) {
  Account(where: { address: { _eq: $address } }) {
    id balanceCNS volumeCNS feesCNS realizedPnlCNS netPnlCNS maxDrawdownCNS
    wins losses grossProfitCNS grossLossCNS currentStreak bestStreak worstStreak totalHoldSeconds liquidations
    positions(where: { isOpen: { _eq: true } }) {
      market { symbol } side lotLNS entryPricePNS depositCNS leverageHdths realizedPnlCNS
    }
    closedTradeList(order_by: { closedAt: desc }, limit: 50) {
      market { symbol } side reason entryPricePNS exitPricePNS maxNotionalCNS netPnlCNS holdSeconds closedAt
    }
    daily(order_by: { date: asc }) { date netPnlCNS cumNetPnlCNS volumeCNS }
  }
}
```

Leaderboard (realized PnL; win rate = wins / (wins + losses), profit factor = grossProfit / grossLoss):

```graphql
query Leaderboard {
  Account(order_by: { netPnlCNS: desc }, limit: 50, where: { closedTrades: { _gte: 10 } }) {
    id address netPnlCNS volumeCNS wins losses grossProfitCNS grossLossCNS maxDrawdownCNS currentStreak
  }
}
```

Copas leader page and execution proof (C7: join `CopyFill.txHash` with `Fill.txHash`):

```graphql
query LeaderPage($leader: String!) {
  Leader_by_pk(id: $leader) {
    owner status bondCNS unitPrice equityCNS maxDrawdownBps mandateMaxDdBps followers totalSlashedCNS
    perplAccount { netPnlCNS maxDrawdownCNS }
    checkpoints(order_by: { timestamp: asc }) { timestamp unitPrice ddBps }
    breaches { epoch reason potCNS claimedCNS }
  }
  CopyFill(where: { leader_id: { _eq: $leader } }, order_by: { timestamp: desc }, limit: 20) {
    vault_id market_id leaderLotLNS targetLotLNS markPricePNS txHash block
  }
}
```

Rows are stored per chain (mainnet and testnet both indexed); filter by chain if you query both.
Live feed: replace `query` with `subscription` (Hasura).

## Known limits

- Market decimals: from `ContractAdded(V2)` events, with a fallback table (`src/perpl.ts`, mainnet markets read from
  `getPerpetualInfo` on 3 Oct 2026). Testnet perps were listed before the testnet start block, so their `Market` rows have
  `symbol` `PERP-<id>` and decimals 0, which makes testnet `notionalCNS`/`openInterestCNS` and the testnet `Protocol` row
  meaningless. The web never shows them: Copas pages read testnet decimals onchain (`getPerpetualInfo`) and every Perpl
  dashboard query filters `chainId = 143`.
- `Account.address` is only known for accounts created after the start block (all of them, if the start block is right).
- OI is derived from position events; `openInterestCNS` uses the last fill price, not the oracle mark.
- Unrealized PnL / liquidation price are not indexed (read `getPosition` live).
- `CopyFill` leader/follower prices and slippage are resolved at query time by joining `Fill` on `txHash`.
- `PositionInverted`: assumed `positionType` is the new side and `pricePNS` the new entry.
