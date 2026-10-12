# Copas keeper

This Node service keeps Copas running. It does seven jobs:

- copies leader fills to follower vaults with `FollowerVault.sync`
- checkpoints leaders
- rolls epochs
- unwinds vaults after a breach or a stop-loss
- settles BreachMarket series
- posts ERC-8004 reputation
- sends alerts

The keeper has **no discretion and holds no funds** (the opt-in DOWN market maker below is separate: own key, own funds). Every call it makes (`sync`, `checkpoint`, `rollEpoch`, `touch`, `settle`) is permissionless and bounded by the contracts. If the keeper is down, anyone can make the same calls. The Privy policy is a second layer on top: it stops the keeper wallet from calling anything else.

## Run

```bash
pnpm install
cp .env.example .env          # set CHAIN_ID + signer (see below)
pnpm test                     # vitest: pure decision logic
pnpm start                    # needs ../contracts/deployments/<CHAIN_ID>.json
```

Node 22+ is required because the service uses `process.loadEnvFile`. If the deployments file is missing, startup exits with a clear error. `contracts/script/Deploy.s.sol` writes that file with the keys `registry, breachMarket, agentRegistry, exchange, ausd, identity8004, block`.

### Hosted tick (GitHub Actions)

`pnpm tick` (`tsx src/index.ts --once`) does one full pass and exits:

1. Loads `data/state-<chainId>.json` and scans `VaultCreated` logs since the saved cursor (100-block chunks, with backoff for the public RPC's 25 req/s limit; the first run backfills from `deployments.block`, about 2 minutes).
2. Reads every leader (`registry.leaderCount/leaderBooks`) and vault.
3. `rollEpoch()` on each leader whose `block.timestamp >= epochEnd`, then `BreachMarket.settle` (and ERC-8004 feedback, if enabled) for the finished epoch.
4. `checkpoint()` on Active leaders whose `unitPrice()` moved since `lastUnitPrice` (otherwise the call writes nothing).
5. `touch()` and then `sync(perpId)` on every market of every vault with a leader. Each job is simulated first. Reverts and `sync` targets equal to the current lot are skipped, so a quiet tick sends no txs.

The exit code is 1 if any tx failed. `KEEPER_DRY_RUN=1` simulates everything but sends nothing. The decisions per leader and vault live in `leaderTickAction` / `vaultSkipReason` in `src/logic.ts`, which are unit-tested.

`.github/workflows/keeper.yml` runs the tick every 5 minutes (GitHub's cron is best effort, so expect 5 to 15 minutes in practice) and on manual dispatch, with the Privy signer and gas sponsorship. Its secrets are `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` and `PRIVY_WALLET_ID`. `data/` is carried between runs with `actions/cache`. Each run's **job summary** lists every tx sent (with explorer links), every skipped job with the reason, and the decision for each leader and vault: see the [keeper workflow runs](https://github.com/PugarHuda/copas/actions/workflows/keeper.yml). The HTTP endpoints, the Alchemy webhook and the per-user `/watch` bot need the long-running `pnpm start`; the tick posts to one Telegram channel instead (below).

#### Telegram channel alerts from the tick (1-minute setup)

At the end of each tick the keeper reads the Copas logs since the last tick (`alertCursor` in `data/state-<chainId>.json`) and posts one message per event to a channel: **new leader** (`LeaderCreated`), **new follower** (`FollowerRegistered`), **epoch rolled** (`EpochRolled`), **breach** (`Breached`, with the slashed pot) and **slash claimed** (`Claimed`), each with an explorer link.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name, and copy the token.
2. Create a channel (public, e.g. `@copas_alerts`, or private), open its settings → Administrators → add the bot with "Post messages".
3. In the GitHub repo: Settings → Secrets and variables → Actions → add `TELEGRAM_BOT_TOKEN` (the token) and `TELEGRAM_CHAT_ID` (`@copas_alerts`, or the `-100…` id of a private channel: forward a channel post to [@userinfobot](https://t.me/userinfobot) to read it).

Without the two secrets the tick skips alerts and just moves the cursor, so turning them on later does not replay history. The first tick with them set only records the cursor; posts start from the next one. If the tick fell more than 10,000 blocks (~1 h) behind, the gap is skipped rather than flooded into the channel. A failed post is retried on the next tick. Locally: put both in `.env` and run `pnpm tick`.

### Signer modes

- `LOCAL` uses `KEEPER_PRIVATE_KEY`, for dev and testnet. The wallet pays its own MON gas. Nonces are managed locally, so several txs can be in flight at once.
- `PRIVY` uses a Privy server wallet through `@privy-io/node` 0.35. Each tx is sent as `eth_sendTransaction` on the wallet RPC with `sponsor: true` (Privy native gas sponsorship), so the wallet address needs no MON. Setup:
  1. Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`. In the Privy dashboard, enable TEE execution and gas sponsorship for Monad and Monad Testnet. Mainnet sponsorship needs prepaid credits.
  2. Run `pnpm privy:setup`. It creates the policy from `privy/policy.json` (chain 143) or `privy/policy.10143.json`, then creates a wallet with that policy attached. A P-256 authorization key owns both. If `PRIVY_AUTHORIZATION_KEY` is empty, the script generates one. Paste the printed values into `.env`.
  3. Run `pnpm privy:deny-demo`. The keeper wallet deliberately tries `AUSD.transfer`. Privy refuses it, and the script saves the refusal to `logs/deny.json`, which is served at `GET /proof/deny` for the web `/proof` page.

### Privy policy (`privy/policy*.json`)

| Rule | Action |
|---|---|
| `eth_sendTransaction`, chain 143/10143, value 0, calldata function in {`sync(uint256)`, `checkpoint()`, `rollEpoch()`, `touch()`, `settle(address,uint256)`} | ALLOW |
| `eth_sendTransaction` to the ERC-8004 ReputationRegistry, function `giveFeedback` only | ALLOW |
| any tx `to` AUSD or the Perpl Exchange | DENY |
| `eth_sign7702Authorization`, `personal_sign`, `eth_signTypedData_v4` | DENY (Privy default-deny: no ALLOW rule matches; Privy rejects conditionless DENY rules) |

Privy denies everything else by default.

**Known limit:** each user gets their own FollowerVault, deployed at runtime. So the ALLOW rule cannot list every Copas address in `to`, and a `to` list is capped at 100 values anyway. The rule pins the function selectors instead. Because the wallet holds no funds, a `sync()` call on some unrelated contract cannot lose anything.

To pin `to` as well:
1. Create a Privy *condition set* named `copas_contracts`.
2. Use `"operator": "in_condition_set"` in the rule.
3. Have the keeper append each new vault or leader on `VaultCreated`/`LeaderCreated`, through REST `condition_sets/{id}/condition_set_items`.

This isn't built because node SDK 0.35 has no helper for that API.

## What it does

| Trigger | Action |
|---|---|
| A Perpl `Position*` event (Opened/Increased/Decreased/Closed/Inverted/Liquidated/Deleveraged/Unwound) whose `accountId` is a Copas leader's `LeaderBook.accountId()` | `sync(perpId)` on every vault following that leader, plus `LeaderBook.checkpoint()` |
| Every `CHECKPOINT_EVERY_BLOCKS` | Refresh all leaders (`registry.leaderBooks`) and call `checkpoint()` on the Active ones |
| `block.timestamp >= epochEnd` | `rollEpoch()`. Then, on `EpochRolled`: `touch()` the following vaults, `BreachMarket.settle(lb, e-1)`, and post ERC-8004 feedback |
| `Breached` | Alerts (breach and claim available), an immediate unwind scan of that leader's vaults, and `settle(lb, e)` |
| Every `UNWIND_SCAN_EVERY_BLOCKS` | For each (vault, market) holding a position whose target is now 0 (leader breached, unbonded, flat or flipped; vault paused or unfollowed): `sync(perpId)` |

**Idempotency.** Every job is first simulated with `eth_call` from the keeper address. If the simulation reverts (epoch still running, series already settled, and so on), there is nothing to do and the job is skipped. A `sync` whose simulated target equals the current lot is also skipped, so it costs no gas. Jobs are de-duplicated by key. If a trigger arrives while the same job is in flight, the job runs once more after it finishes. A failed tx is logged and counted, and never crashes the loop. Logs are structured JSON lines.

**Discovery.** Leaders come from `registry.leaderCount/leaderBooks`. Vaults come from `VaultCreated` logs: the first run backfills them from `deployments.block` in 100-block chunks, and the list is saved in `data/state-<chainId>.json`. Each vault's `leader()/following()/paused()/accountId()` is refreshed on `Followed`, `Unfollowed`, `FollowerRegistered` and `StopLoss`, and once per checkpoint period.

**Log source.** The keeper makes one `eth_getLogs` call per range of up to 100 blocks, filtered by event topics only. It then keeps only logs from the exchange or from known Copas addresses. With `MONAD_WS_URL` set, new heads arrive over WebSocket and wake the loop right away. Otherwise it polls every `POLL_MS`. On restart the live cursor starts at the current head. The periodic checkpoint, roll and unwind jobs catch up on state from the missed blocks, but alerts from the downtime are not replayed.

## ERC-8004 reputation (`ENABLE_8004_FEEDBACK=true`)

After each finished epoch of a leader with `AgentLeaderRegistry.agentOf(lb) != 0`, the keeper calls the ReputationRegistry v2.0.0:

- Mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, testnet `0x8004B663056A597Dffe9eCcC1965A193B7388713`. `getVersion()` returns "2.0.0" on both.
- IdentityRegistry: mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`. The testnet address is different from mainnet.
- The ABI was verified by probing the implementation bytecode behind the proxy (selector `0x3c036a7e`):
  `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`
- A clean epoch posts `value=100` with tags `copas` / `epoch-clean`. A breach posts `value=-100` with tags `copas` / `breach-drawdown`, `breach-leverage`, `breach-notional` or `breach-market`. The endpoint is `copas:<chainId>:<leaderBook>:epoch-<e>`.
- **Signer caveat:** the registry reverts with `"Self-feedback not allowed"` when the sender owns or operates the agent. So the keeper wallet must be a different address from both the agent owner and the agent wallet. That holds by default, because agent owners are leaders. The pre-send simulation catches the revert and logs a warning. Epochs that already got feedback are recorded in `data/state-*.json`.

## DOWN market maker (`MM_PRIVATE_KEY`, testnet)

Step 4 of `pnpm tick` (`src/mm.ts`, decisions in `src/mmLogic.ts`, tested in `test/mm.test.ts`) keeps a live breach-risk book for every Active leader. It is the one part of the keeper that holds funds, so it signs with its own plain key, not the Privy wallet (whose policy denies AUSD on purpose). Without `MM_PRIVATE_KEY`, or on mainnet (Kuru listing is owner-only there), it does nothing.

Per Active leader, for the running epoch and, in its last `MM_PREMINT_SEC` (900 s), for epoch+1:

1. **Series:** if the MM holds less than one quote of DOWN, `BreachMarket.mint(lb, e, n, mm)` (`MM_MINT_SIZE` 100 pairs, at most `MM_MAX_MINT_PER_SERIES` 300 per series).
2. **Book:** the DOWN/AUSD Kuru market address is deterministic (`Router.computeAddress` over the `onramp/src/kuru/market.ts` defaults). No code there: `Router.deployProxy`. The web finds the same address the same way (`web/lib/copas/data.ts`), so there is no registry to keep in sync.
3. **Quotes:** all DOWN goes into the Kuru MarginAccount and `MM_MARGIN_AUSD` (50) AUSD is kept there for bids. Our live orders are read from `s_orders` (stateless, nothing cached between ticks). One bid and one ask of `MM_QUOTE_SIZE` (50 DOWN) sit at p ∓ `MM_SPREAD`/2 (0.04 wide; the bid never below p/2). A side is replaced (one `batchUpdate`: cancel + post) only when it is more than `MM_REQUOTE` (0.005) from target, less than half filled, or duplicated. Bids stop above `MM_MAX_DOWN` (200) DOWN of inventory.
4. **Sweep:** every series of `e-2 … e+1` it no longer quotes (finished, breached, leader not Active, epoch over but not rolled) gets its orders cancelled, its DOWN withdrawn from Kuru, and the winning side redeemed (`redeemPair` while unsettled).

Caps: `MM_MAX_SPEND_PER_TICK` (500 AUSD minted + deposited per tick, all leaders), no new series below 0.4 MON, and the MM tops itself up from the testnet AUSD faucet below `MM_MIN_AUSD` (1,000). Every send is simulated first and journaled in the job summary (`mm:*` rows), with one decision row per series showing p and its inputs.

**Fair price** (probability the leader breaches its drawdown mandate before the epoch ends):

```
dd    = max(0, (peak - u) / peak)              u = LeaderBook.unitPrice(), peak = peakUnitPrice() (resets each epoch)
b     = ln((1 - dd) / (1 - maxDD))             log distance to the breach level peak·(1 - maxDD), maxDD = mandate.maxDDbps
s     = σ · sqrt(secondsLeft / 1 day)          σ = MM_SIGMA_DAILY (0.10); secondsLeft = epochEnd - now (epochLen for epoch+1, dd = 0)
pDiff = 2 · Φ(-b / s)                          reflection principle: a driftless log price touches the barrier
r     = riskBump[riskLevel] = 0 / .05 / .15 / .35, from CopasRiskConsumer.latest(lb) if under a day old (CRE workflow)
p     = clamp(1 - (1 - pFloor)(1 - pDiff)(1 - r), pFloor = 0.02, 0.98)      dd ≥ maxDD → 0.98
```

pFloor is the jump risk the diffusion term cannot see. Gas is the real cost: a new series is about 0.33 MON at testnet prices (mint deploys two tokens, `deployProxy` a book and its vault), so with 1-hour epochs budget roughly 8 MON per Active leader per day. Known limit: between ticks (5 min) a breach can hit the resting ask before the sweep cancels it.

## Alerts (G4)

**Telegram:** set `TELEGRAM_BOT_TOKEN` (get one from @BotFather). Users send the bot:
- `/start` for all alerts
- `/watch <leaderBook|vault>` to narrow them
- `/unwatch <addr>`, `/list`, `/stop`

Subscribers are stored in `data/subscribers.json`.

The keeper sends these alerts:
- leader opened, closed or was liquidated on a position
- drawdown reached 80% of the mandate (once per leader per epoch)
- breach
- claim available
- leader requested unbond
- follower stop-loss

### Alchemy Notify: `POST /webhooks/alchemy`

The endpoint checks that `x-alchemy-signature` equals the hex HMAC-SHA256 of the raw body, keyed with `ALCHEMY_WEBHOOK_SIGNING_KEY`. If it doesn't match, it returns 401. For each tx hash in the payload, it fetches the receipt, decodes the Copas and Perpl logs, and passes them to the same handler the poller uses. Logs are de-duplicated by `txHash:logIndex`, so an event that arrives both ways alerts once.

To create the webhook in the dashboard, go to *Data → Webhooks → Address Activity* and pick Monad Mainnet or Monad Testnet. Or use the API:

```bash
curl -X POST https://dashboard.alchemy.com/api/create-webhook \
  -H "X-Alchemy-Token: $ALCHEMY_AUTH_TOKEN" -H "content-type: application/json" \
  -d '{"network":"MONAD_TESTNET","webhook_type":"ADDRESS_ACTIVITY",
       "webhook_url":"https://<keeper-host>/webhooks/alchemy",
       "addresses":["<registry>","<breachMarket>","<leaderBook...>","<vault...>"]}'
# add new leaderBooks/vaults later:
# PATCH https://dashboard.alchemy.com/api/update-webhook-addresses
#   {"webhook_id":"wh_...","addresses_to_add":["0x..."],"addresses_to_remove":[]}
```

Use `MONAD_MAINNET` for chain 143. Copy the webhook's *signing key* into `ALCHEMY_WEBHOOK_SIGNING_KEY`. Address-activity webhooks only fire on value or token transfers that touch the listed addresses: deposits, claims and slashes. The poller covers every other event. The webhook is just an extra low-latency path.

## HTTP (port `PORT`, CORS open for the web app)

- `GET /health` returns `{ ok, lastBlock, processedBlock }`. `ok` is false when processing lags more than 300 blocks behind.
- `GET /metrics` returns:
  - the signer and the last block
  - counters: `syncsSent`, `syncsSkipped`, `checkpoints`, `rolls`, `touches`, `settles`, `feedbacks`, `txFailed`, `breachesSeen`, `leaderFills`
  - `latencyBlocks {last, avg, p50, max}`: blocks from the leader's fill to the follower's sync receipt
  - `recentTx` and `recentAlerts`
- `GET /proof/deny` returns `logs/deny.json`.

## Layout

- `src/logic.ts`: pure logic, tested
- `src/mm.ts`, `src/mmLogic.ts`: DOWN market maker (I/O, pure pricing/decisions)
- `src/keeper.ts`: log watching and jobs
- `src/signer.ts`: LOCAL/PRIVY signers
- `src/erc8004.ts`, `src/alerts.ts`, `src/http.ts`, `src/config.ts`
- `scripts/privy-*.ts`
- `privy/policy*.json`
