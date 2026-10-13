# How Copas uses Kimi K3: an AI that explains, a contract that enforces

*Copas, Monad Metropolis hackathon, 14 Oct 2026*

Copas is bonded copy trading on Monad. A leader posts an AUSD bond and an onchain mandate (max drawdown, leverage, size, markets). Followers copy the leader's Perpl positions through a vault they own. If the leader breaks the mandate, the bond is slashed to the followers. All of that is deterministic: contracts read Perpl state in the same block and nobody, human or model, can change a payout.

That leaves one hard problem that contracts can't solve: **helping a retail follower understand a trader before they put money in.** A leader page full of drawdown curves, fill counts and leverage numbers doesn't help someone who has never traded perps. This is the job we give Kimi K3.

## The rule: Kimi explains, it never decides

Kimi K3 is Copas's risk analyst. It gets a block of features that our code has already computed deterministically from Perpl data for one leader, and it writes the explanation a follower reads on the leader page. The system prompt (`services/src/kimi.ts`) is strict:

- use only numbers that appear in the input, never invent prices or forecasts;
- never tell the user to buy, sell or follow, because execution belongs to the contracts;
- the tilt and drift flags must equal the input flags; Kimi only explains them;
- write for a person: dates as dates, no field names, no scores, at most two sentences per field.

What Kimi returns, as structured JSON:

1. **Style summary**: what kind of trader this is, restating the leader's real activity (open positions, side, size, entry, unrealized PnL).
2. **Weekly summary**: what they did in the last 7 days.
3. **Tilt and drift explanations**: if our code flagged revenge sizing after losses, or a drift away from the leader's declared mandate, Kimi explains it in plain words ("2 times they increased size after a loss").
4. **Devil's advocate**: exactly three reasons *not* to follow this leader, picked by Kimi from a deterministic ranked list and explained with their numbers. Every follow decision on Copas comes with the case against it.

A guard (`guardAnalysis`) checks the output before anyone sees it: flags must match, the devil's-advocate keys must come from the input list, and if Kimi returns fewer than three, the list is filled from the deterministic ranking.

## Why Kimi K3 specifically: signed answers

Every request carries an `X-Msh-Request-Nonce`, and Kimi returns a **Request Signature** over the response. Copas verifies it against Moonshot's `POST /v1/signatures/verify` and returns it with the analysis, together with SHA-256 hashes of the exact input and output (appended to `data/kimi-log.jsonl`). So when a follower or a judge reads "this leader doubled size after two losses", they can check that the text really came from Kimi K3 for that input, and was not edited by us afterwards. For an app whose whole pitch is "don't trust the leader, check the chain", an AI explanation you can verify is the right fit.

A real call, 13 Oct 2026, leader `0xda695cB060c7e2dF0b5c36EA591eA69399463D90` on Monad testnet:

```
GET https://copas-services.vercel.app/leader/0xda695cB060c7e2dF0b5c36EA591eA69399463D90/analysis
model:          kimi-k3
signature:      reqsigv1_v0LF0wDuIxPRwLT01E-Xu3PMIaDXfcG53BTVFau97Uik4dakfJzK2vg3...
nonce:          4f25a9bd-56ab-4a1c-b675-db7ed8f43273
signatureValid: true
costUsd:        0.007671
styleSummary:   "This leader is brand new, with no closed trades yet and a single open position.
                 They are long 0.0002 BTC from an entry of 83597.7 (now marking 83164.3, ...)"
```

One analysis costs under one cent at K3 prices ($3 / $15 per million input/output tokens, $0.30 cached input), so it can run on every leader page view without a paywall.

## Where Kimi shows up in the product

- **Leader page**, "AI risk analysis" panel: *AI explains, the contract enforces*. Style, weekly summary, tilt and drift, and the three reasons not to follow.
- **MCP server** for AI agents (`https://copas-services.vercel.app/mcp`): an agent can ask for the same signed analysis before it follows a leader with the MetaMask `mm copas` plugin, whose risk limits are mandatory.
- **x402 pay-per-call report** (`GET /x402/report/:addr`, 0.01 USDC on Monad testnet): a signed Perpl track record plus the Kimi analysis, for other agents.
- **Chainlink CRE workflow** `copas-risk-guardian`: an LLM risk score is one input to a consensus report that can checkpoint risky leaders onchain, with a deterministic fallback when the model is unavailable.

## What value Kimi brought

Without Kimi, Copas would show retail users numbers. With Kimi, it shows them sentences, including the uncomfortable ones: three concrete reasons not to follow, on every leader, backed by the leader's real data, with a signature anyone can verify. Kimi never touches money, and that is exactly what makes it safe to put in front of followers.

Code: [`services/src/kimi.ts`](../services/src/kimi.ts) · Live: https://copas-mocha.vercel.app · Repo: https://github.com/PugarHuda/copas
