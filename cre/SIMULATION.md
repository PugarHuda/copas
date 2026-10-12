# CRE simulation log: copas-risk-guardian

**12 Oct 2026: simulated end to end on Monad testnet with `--broadcast` (CRE CLI v1.38.0, logged in).** The workflow read both Copas leaders from the registry, checked Perpl marks against CoinGecko, scored risk with the LLM (OpenRouter free model, median consensus across nodes) and wrote the DON report to `CopasRiskConsumer` `0xBc28c947e51572e55eeb0f988a068C7A0f4ec7b0` through the MockKeystoneForwarder: tx `0x28bdb9385d27536d9a42c42b993141a168fb295ced9a0954fd3ccbe392dfe878`.

Fixed on the way: the WASM runtime (Javy/QuickJS) has no `btoa`/`TextEncoder`, so the LLM request body encoder (`risk.ts` `toBase64`) failed with "not a function"; it is now a hand-written UTF-8 + base64 encoder (tested against Buffer).

```
$ cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0 --broadcast
2026-10-12T11:53:08Z [USER LOG] registry 0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d: 2 leader(s), evaluating 2
2026-10-12T11:53:11Z [USER LOG] price BTC: perpl=84017.5 cex=83981 div=4bps
2026-10-12T11:53:11Z [USER LOG] price MON: perpl=0.02675 cex=0.02672471 div=9bps
2026-10-12T11:53:11Z [USER LOG] price ETH: perpl=2561.24 cex=2559.55 div=7bps
2026-10-12T11:53:19Z [USER LOG] leader 0xda695cB060c7e2dF0b5c36EA591eA69399463D90 risk=0(llm) dd=0% llmDD=0 checkpoint=false
2026-10-12T11:53:22Z [USER LOG] report written to 0xBc28c947e51572e55eeb0f988a068C7A0f4ec7b0 tx=0x28bdb9385d27536d9a42c42b993141a168fb295ced9a0954fd3ccbe392dfe878
```

---

Earlier notes (4 Oct, before the login):


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
