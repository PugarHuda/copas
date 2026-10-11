# @copas/onramp

Funding services for Copas: get money from any chain into a user's `FollowerVault` (AUSD on Monad).
It is a library plus a small Hono server, and `copas/web` calls it.

| Spec | What | Module |
|---|---|---|
| F1 | Aurora Intents: any chain to USDC on Monad, through a 1Click deposit address. An Intents Connect recipe sits behind a flag. | `src/aurora/oneclick.ts`, `src/aurora/connect.ts` |
| F3 | Kuru Flow: USDC/MON to AUSD (JWT, 1 req/s limiter, referrer), optionally followed by the vault deposit | `src/kuru/flow.ts` |
| F2 | Socket V3 deposit address: USDT on BSC to AUSD on Monad | `src/socket.ts` |
| B2 | Kuru V1 market for BreachMarket DOWN tokens on testnet | `scripts/kuru-down-market.ts`, `src/kuru/market.ts` |

```bash
pnpm install
cp .env.example .env      # every key is optional
pnpm build && pnpm test   # tests replay live-recorded fixtures in test/fixtures
pnpm dev                  # http://localhost:8787
```

## HTTP routes

Amounts are atomic-unit strings. Requests are validated (EVM addresses, positive integers) before any upstream call. When an upstream fails, the route returns `502 {error, upstreamStatus, upstream}` and API keys are never echoed. A timeout returns `504`.

| Route | Body / params | Returns |
|---|---|---|
| `GET /health` | | which Aurora host is used, and whether Connect is on |
| `GET /aurora/sources` | | supported source tokens (Base/Arbitrum/Ethereum/Solana USDC + native, BSC USDT) |
| `POST /aurora/quote` | `{source:"base:USDC", amount, refundTo, recipient}` | dry 1Click quote to USDC on Monad |
| `POST /aurora/deposit-address` | same + `persistent?` | `{depositAddress, amountIn, minAmountOut, deadline, statusId}` |
| `GET /aurora/status/:depositAddress` | | `{phase, terminal, readyForDeposit, refunded, refundReason, originTx, destinationTx, raw}` |
| `POST /aurora/connect/plan` | `{wallet, vault, expectedUsdc, intermediary?, reserveBps?}` | recipe params (needs `AURORA_CONNECT=1`) |
| `POST /aurora/connect/api/v1/executions/:wallet[/steps]` | SDK body | key proxy for the two create calls only |
| `POST /kuru/quote` | `{userAddress, tokenIn:"USDC"\|"MON"\|0x.., amount, vault?}` | `{output, minOut, txs[]}` |
| `POST /socket/deposit-address` | `{receiver, amount, refundAddress?}` | `{quoteId, depositAddress, token, amount, output, bridge, txData, statusId}` |
| `GET /socket/status/:quoteId` | | `{status, terminal, originTx, destinationTx, refund}` |

## F1: deposit-and-follow (Aurora)

**Default path (no alpha access needed).**

1. `POST /aurora/deposit-address` with `recipient` set to the user's Mera EOA and `refundTo` set to their address on the origin chain. The user sends the source token to `depositAddress`. Solana sources need a Solana `refundTo`.
2. Poll `GET /aurora/status/:depositAddress` every 5 to 10 s. Aurora's limits are 100 req/10 s and 2000/h per key, and rejected requests still count toward them. The phases are:
   - `awaiting_deposit`
   - `processing`
   - `delivered`: USDC has reached the EOA and `readyForDeposit` is true.
   - `incomplete_deposit`: the user sent less than `minAmountIn`. They can top up before the deadline; otherwise the funds are refunded.
   - `refunded`: show `refunded` and `refundReason`. The funds go back to `refundTo` on the origin chain.
   - `failed`
3. Once the phase is `delivered`, call `POST /kuru/quote {userAddress: EOA, tokenIn: "USDC", amount: receivedAtomic, vault}`. It returns four txs: `approve(KuruFlow)`, the swap, `AUSD.approve(vault)` and `FollowerVault.deposit(minOut)`. Mera sends them as one batch. Any AUSD above `minOut` stays in the wallet.

Without `AURORA_API_KEY`, the server calls the public host `1click.chaindefuser.com/v0`, which charges 25 bps. With a key it calls `intents-api.aurora.dev/api/{quote,status}/{key}`. The two hosts use the same request and response shapes. `persistent: true` asks for a reusable per-user address, which needs an Aurora-approved org. If that returns 403, the route falls back to a per-quote address.

**Intents Connect recipe (`AURORA_CONNECT=1`).** The recipe is `depositAndFollowRecipe` in `@copas/onramp/connect`. It is a bridge-in to USDC on Monad. The intermediary then runs four steps:

1. `USDC.approve(KuruFlow, {MIN_AMOUNT_OUT})`
2. `KuruFlow.executeSwap(... amountIn={MIN_AMOUNT_OUT})`
3. `AUSD.approve(vault, d)`
4. `FollowerVault.deposit(d)`

The recipe never sets `quote.recipient`. The user signs once on the origin chain. The browser wires it up like this:

```ts
import { createExecutionRunner, createIntentsConnectApi } from '@aurora-is-near/intents-connect';
import { depositAndFollowRecipe } from '@copas/onramp/connect';

const { params } = await post('/aurora/connect/plan', { wallet, vault, expectedUsdc: dryQuote.minAmountOut });
const runner = createExecutionRunner({
  api: createIntentsConnectApi({ baseUrl: 'https://intents-connect-alpha-api.aurora.dev', apiKeyProxyUrl: `${ONRAMP}/aurora/connect` }),
  wallet: connector, onEvent,
});
await runner.run({ recipe: depositAndFollowRecipe, params, quote: { originAsset, destinationAsset: USDC_MONAD, amount, swapType: 'EXACT_INPUT', slippageTolerance: 100 },
  originChain: 'base', originToken: { contractAddress, decimals: 6 }, depositViaWallet: true });
```

Kuru Flow's entrypoint is unverified, and selector `0xce1e7030` is not in any public signature database. I recovered the signature `executeSwap((address,uint256,address,uint256),(address,uint256,address,uint256,bool),bytes)` by brute-forcing the selector. The test decodes and re-encodes both live quotes byte for byte. That is what lets the swap be written as a Connect step.

`planDepositAndFollow` pre-quotes the swap for the intermediary at `expectedUsdc × (1 − 3%)`, which leaves room for the Connect network fee. The step then swaps the real `{MIN_AMOUNT_OUT}`. Routes are share-based, so the pre-quoted `minOut` still holds. The vault receives `minOut`, and any extra AUSD stays in the user's intermediary, where a steps-only run can sweep it.

## F3: Kuru Flow

`KuruFlow` caches a JWT per user until 60 s before `expires_at`. All calls go through one 1.1 s queue, because the limit is 1 rps with a burst of 1. When `KURU_REFERRER` is set, it adds `referrerAddress`/`referrerFeeBps`; the referrer fixture shows both fields encoded into the calldata. The native MON address is `0x000…000`.

## F2: Socket deposit address

The route calls `GET /v3/swap/quote?userOps=deposit` with a required `refundAddress`, which defaults to the receiver. Mera is an EOA, so the same address works on BSC. It takes the first route that is already active. If no route is active, it calls `POST /v3/swap/quote/{id}/activate` on the best one. The user must send exactly `amount` of `token`. Poll `/socket/status/:quoteId` every 5 to 10 s. The terminal states are `COMPLETED`, `FAILED`, `EXPIRED` and `REFUNDED`.

## B2: Kuru market for DOWN tokens

```bash
pnpm kuru:down-market simulate --down <DOWN token>     # no key needed
PRIVATE_KEY=0x.. pnpm kuru:down-market deploy --breach-market 0x.. --leader-book 0x.. --epoch 3
pnpm kuru:down-market book    --market 0x..
pnpm kuru:down-market deposit --market 0x.. --token ausd --amount 50   # MarginAccount, needed for limit orders
pnpm kuru:down-market limit   --market 0x.. --side buy  --price 0.12 --size 10
pnpm kuru:down-market market  --market 0x.. --side sell --amount 5
```

- **Testnet.** The script uses the Kuru V1 router `0x7EFbE105…4630` on Monad testnet (10143), with Perpl testnet AUSD as the quote token. The default book has price precision 1e4, size precision 1e2, a 0.001 tick and a 1 DOWN minimum (`DOWN_MARKET_DEFAULTS`).
- **Mainnet.** Listing is permissioned. `Router.deployProxy` on `0xd651…95CC` reverts `Unauthorized()` for anyone except Kuru's Safe multisig. On mainnet, DOWN is mint/redeem only through `BreachMarket`.
- **Web reuse.** `src/kuru/market.ts` builds the order calldata, so the web UI can reuse it.

## Verification log

| Item | Status |
|---|---|
| 1Click quote, dry and live (Base, Arbitrum, Ethereum, Solana to USDC on Monad), deposit address, status | Live on 3 Oct (fixtures). **On 11 Oct, 1Click returned `400 No liquidity available` for every source into Monad.** Base to Arbitrum still quoted, so the API was up and only Monad liquidity was missing. Recheck before the demo. The UI shows the upstream message. |
| Aurora host with a key | Shape verified. A bad key returns `404 Application key not found` (fixture). |
| Connect API | `GET intermediary` and `GET executions` are public and live (fixtures). `POST executions` without a key returns `401 missing or invalid api token`, so create calls need alpha access. Step placeholders inside nested tuple parameters have not been tested against the service. |
| Kuru Flow | generate-token and quote for USDC→AUSD and MON→AUSD with a referrer: live on 3 Oct and 11 Oct |
| Socket V3 | Deposit quote and status: live on 3 Oct and again on 11 Oct (route `rfq-vault-executor`, about 5 s) |
| Kuru V1 testnet | `deployProxy` with the default params simulates OK from a random address on 11 Oct, using testnet USDC `0x534b…43A3` as a 6-decimal stand-in for DOWN |
