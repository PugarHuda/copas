# CRE simulation log: copas-risk-guardian

Status as of 4 Oct 2026: **the CLI simulation has not run yet. `cre workflow simulate` needs a CRE account login (`cre login` opens a browser) or `CRE_API_KEY`, and neither exists on this machine yet.** Everything that can run without a login has been run, with the results below. When the login is in place, run the commands at the bottom and paste their output into this file.

## Environment

- Windows 11, Git Bash
- Bun 1.4.2 (`npm i -g bun`)
- CRE CLI v1.36.0 (`cre_windows_amd64.zip` from GitHub releases, sha256 `44abc78f…595b1a` matches `checksums.txt`), installed at `C:\Users\pc\.cre\bin\cre.exe`
- `@chainlink/cre-sdk` 1.23.0, viem 2.57.2, Javy plugin v8.1.0
- Foundry forge 1.8.0

## 1. Simulation attempt (blocked by auth)

```
$ cre workflow simulate copas-risk-guardian -T mainnet-settings --non-interactive --trigger-index 0
Initializing...
! You are not logged in
✗ Authentication required: not logged in and no CRE_API_KEY set
  → Run 'cre login' interactively, or
  → Set CRE_API_KEY environment variable for non-interactive use
```

## 2. Typecheck, unit tests, WASM build (what `cre workflow simulate` compiles)

```
$ bunx tsc --noEmit            # no errors
$ bun test
 4 pass
 0 fail
 15 expect() calls
$ bunx cre-compile main.ts guardian.wasm
  guardian.js  0.81 MB  (entry point)
✅ Compiled: guardian.wasm        (2.6 MB, javy v8.1.0)
✅ Workflow built
```

## 3. Consumer contract

```
$ cd contracts && forge test
[PASS] test_checkpointsFlaggedLeadersOnly()
[PASS] test_expectedAuthor()
[PASS] test_onlyForwarder()
[PASS] test_onlyOwnerSetsForwarder()
[PASS] test_revertingCheckpointDoesNotBlockOthers()
[PASS] test_skipsUnknownLeader()
Suite result: ok. 6 passed; 0 failed
```

## 4. Live check of the workflow's EVM read A (same Multicall3 encode/decode as `main.ts`, run with viem)

```
https://rpc.monad.xyz          req 1092 B, resp 2240 B   (quota: 5 KB)
  perp 1  BTC  84777.8   valid
  perp 10 MON  0.034537  valid
  perp 20 ETH  2692.8    valid
  perp 31 SOL  120.131   valid
https://testnet-rpc.monad.xyz  req 836 B, resp 1696 B
  perp 16 BTC  84754.4   valid
  perp 64 MON  0.03452   valid
  perp 32 ETH  2692.7    valid
```

CoinGecko returned BTC 84825, ETH 2679.41, SOL 119.62, MON 0.03151 at about the same time. The step-2 logic would compute these divergences:

| Market | Divergence | Result |
|---|---|---|
| BTC | ~6 bps | ok |
| ETH | ~50 bps | ok |
| SOL | ~43 bps | ok |
| MON | ~950 bps | **FLAG** |

The MON gap is either a real Perpl/CEX gap or the wrong CoinGecko id; confirm the id before the demo.

## To finish (when a CRE login exists)

```bash
cd copas/cre
cre login
cre workflow simulate copas-risk-guardian -T mainnet-settings --non-interactive --trigger-index 0 | tee -a SIMULATION.md
cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0 | tee -a SIMULATION.md
# after Copas + CopasRiskConsumer (MockKeystoneForwarder) are deployed on testnet and configs are filled:
cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0 --broadcast | tee -a SIMULATION.md
```
