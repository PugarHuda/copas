# Copas × Chainlink CRE: `copas-risk-guardian`

A CRE workflow that watches every bonded Copas leader on Monad. Every 5 minutes it checks Perpl mark prices against an external price source, has an LLM (OpenRouter free model) score each leader's risk, and writes a DON-signed report onchain. That report makes CRE an **independent checkpoint caller**: if a leader is close to breaking its mandate, CRE calls `LeaderBook.checkpoint()`. If the mandate is actually broken, that call slashes the bond and pays it out to followers, even when no keeper, follower or Copas server is online. It works like the "Automated Liquidation Protection" pattern, applied to copy-trading followers.

```
           ┌──────────────── CRE DON (cron "0 */5 * * * *") ─────────────────┐
 Monad ───►│ 1 EVM read  CopasRegistry.leaderCount/leaderBooks                │
 (Multicall3)│            LeaderBook.status/equity/mandate/peak/lastUnitPrice │
           │            Perpl Exchange getPosition(perpId,1) → mark price     │
 CoinGecko►│ 2 HTTP      reference prices → divergence flag (> maxDivergenceBps)│  median per field
 LLM ─────►│ 3 HTTP      strict json_schema {index,riskLevel,ddToLimitPct,note}│  median per field
           │ 4 report    abi.encode(Note[]) signed by the DON                 │
           └───────────────────────────────┬──────────────────────────────────┘
                                           ▼ KeystoneForwarder (MockKeystoneForwarder in simulation)
                         CopasRiskConsumer.onReport(metadata, report)
                           ├─ checks msg.sender == forwarder (+ optional workflow owner)
                           ├─ skips anything that is not registry.isLeaderBook(...)
                           ├─ stores latest[leader], emits RiskNote(leader, riskLevel, ddToLimitPct, noteHash)
                           └─ riskLevel ≥ 2 or ddToLimitPct ≥ 80 → try LeaderBook.checkpoint()
```

## Files that use Chainlink

| File | What it does |
|---|---|
| [`copas-risk-guardian/main.ts`](copas-risk-guardian/main.ts) | The workflow: `CronCapability`, `EVMClient.callContract` (Multicall3, chunked), `HTTPClient.sendRequest` with `ConsensusAggregationByFields(median)`, `runtime.getSecret`, `runtime.report`, `EVMClient.writeReport` |
| [`copas-risk-guardian/risk.ts`](copas-risk-guardian/risk.ts) | Deterministic helpers: drawdown math (the same formula as `LeaderBook._checkpoint`), divergence, LLM JSON schema and parser, fallback score, note text |
| [`copas-risk-guardian/risk.test.ts`](copas-risk-guardian/risk.test.ts) | `bun test` for the helpers |
| [`contracts/src/CopasRiskConsumer.sol`](contracts/src/CopasRiskConsumer.sol) | CRE receiver (`IReceiver.onReport` + ERC165), validates the forwarder, then stores notes and calls checkpoints |
| [`contracts/test/CopasRiskConsumer.t.sol`](contracts/test/CopasRiskConsumer.t.sol) | Foundry tests: forwarder-only, flag rule, unknown leaders skipped, reverting leader isolated, author check |
| [`project.yaml`](project.yaml), [`copas-risk-guardian/workflow.yaml`](copas-risk-guardian/workflow.yaml) | Targets `mainnet-settings` (`monad-mainnet`) and `testnet-settings` (`monad-testnet`) |
| [`copas-risk-guardian/config.mainnet.json`](copas-risk-guardian/config.mainnet.json), [`config.testnet.json`](copas-risk-guardian/config.testnet.json) | Addresses, markets, thresholds, LLM settings |
| [`secrets.yaml`](secrets.yaml), [`.env.example`](.env.example) | `LLM_API_KEY` (OpenRouter) secret mapping (Vault DON when deployed, `.env` in simulation) |

## How this fits the bounty ("Best workflow with CRE")

- **CRE is the orchestration layer.** One workflow combines a blockchain (Monad reads and writes), an external API (CoinGecko) and an LLM (an LLM (OpenRouter)). The workflow decides what runs, in what order, and what lands onchain. No Copas backend is involved.
- **Consensus over AI output.** The LLM (OpenRouter free model) must answer with a strict `json_schema`. Each node's answer is parsed into fixed numeric fields (`r<i>`, `d<i>`), and the DON takes the **median per field**. Free-text notes never go into consensus. Instead, `noteHash` is the keccak of a deterministic note string that every node builds identically.
- **AI explains, rules execute** (SPEC §1.5). The LLM score can only *trigger* `checkpoint()`, and anyone can already call that function. The slash itself is decided by the contract from Perpl state. The `ddToLimitPct` written onchain is computed deterministically from LeaderBook state; the LLM's own estimate is only logged as a cross-check. If the key or the API fails, the workflow falls back to a deterministic score.
- **Safety in the consumer:** forwarder check, optional workflow-owner check, registry allowlist (no arbitrary calls), and `try/catch` per leader.
- **Within quotas:** at most 2 HTTP calls per run (limit 15); EVM reads are batched through Multicall3 in chunks of 16 calls (2–4 reads, limit 15, each under the 5 KB payload limit; measured at 1.1 KB request / 2.2 KB response for the mainnet marks); 1 secret.

## Run it

Prerequisites: Bun ≥ 1.2.21 (`npm i -g bun`), the CRE CLI (`cre_windows_amd64.zip` from https://github.com/smartcontractkit/cre-cli/releases, v1.36.0 tested), and a CRE account (`cre login`, which opens a browser).

```bash
cd copas/cre
cp .env.example .env                      # add LLM_API_KEY_VAR=sk-or-... (OpenRouter) for the LLM step
(cd copas-risk-guardian && bun install)   # also installs the Javy plugin (cre-setup)
cre login
cre workflow simulate copas-risk-guardian -T mainnet-settings --non-interactive --trigger-index 0
cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0
# onchain write through the MockKeystoneForwarder (needs a funded CRE_ETH_PRIVATE_KEY in .env):
cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0 --broadcast
```

Checks that do not need a login:

```bash
cd copas-risk-guardian && bunx tsc --noEmit && bun test && bunx cre-compile main.ts /tmp/guardian.wasm
cd ../contracts && forge test
```

### Deploying the consumer

The forwarder must match the mode you run in. Simulation `--broadcast` uses the MockKeystoneForwarder; a deployed workflow uses the KeystoneForwarder. You can switch later with `setForwarder`.

| | Mainnet (143) | Testnet (10143) |
|---|---|---|
| MockKeystoneForwarder (simulate `--broadcast`) | `0x9eF6468C5f37b976E57d52054c693269479A784d` | `0xB9F79d863261869B234c481D1f9A7af84AeAd192` |
| KeystoneForwarder (production DON) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

```bash
cd copas/cre/contracts
forge create src/CopasRiskConsumer.sol:CopasRiskConsumer --rpc-url $MONAD_TESTNET_RPC_URL --private-key $PK --broadcast \
  --constructor-args <CopasRegistry from copas/contracts/deployments/10143.json> 0xB9F79d863261869B234c481D1f9A7af84AeAd192
```

Then put `registry` and `consumer` into `config.testnet.json` (or `config.mainnet.json`). While either is the zero address, the workflow still runs: it reads Perpl marks, checks prices and logs the result, then skips the leader or write steps.

## Config knobs

`maxDivergenceBps` (100) sets the sanity flag threshold. `maxLeaders` (16) caps how many leaders are evaluated per run. `callsPerRead` (16) sets the Multicall chunk size. `gasLimit` (3,000,000) covers a few checkpoints that each slash. The checkpoint thresholds (`riskLevel ≥ 2`, `ddToLimitPct ≥ 80`) are constants in both `risk.ts` and `CopasRiskConsumer.sol`.
