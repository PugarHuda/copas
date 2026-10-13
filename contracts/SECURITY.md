# Copas contracts: security review (13 Oct 2026)

Internal review, not an audit. Testnet only (Monad 10143), deposits capped by `maxVaultDepositCNS`.

What was run:
- `forge test --no-match-path "test/fork/*"`: 36 tests, all pass. That includes the 3-invariant suite (`CopasInvariant.t.sol`: claims never exceed the pot, LeaderBook stays solvent, sync never ends up opposite the leader) and the new `test/Security.t.sol`. The fork tests need a mainnet RPC at a pinned block and were not run.
- New fuzz tests in `Security.t.sol` (256 runs each): claims are bounded by the pot, by each vault's pro-rata share and by its loss, and a sweep moves exactly the remainder. Vault deposit/withdraw conserves funds and pays only the owner. BreachMarket stays fully collateralised through mint, pair-redeem, settle and redeem. Consent: a looser live mandate means zero copying.
- Slither 0.11.6 (`slither . --filter-paths "lib/|test/" --exclude-informational --exclude-optimization`), triaged below.

## Findings

The deployed testnet contracts are verified on Sourcify from this source, so `src/` is left as deployed.
The fixes live in `security-fixes.patch`, which covers `src/FollowerVault.sol`, `src/UnderwriterPool.sol` and the matching test flips.
`git apply contracts/security-fixes.patch && forge test` passes, 36/36.
Each `test_KNOWN_*` test in `Security.t.sol` reproduces its bug against the deployed source.

| # | Severity | Status | Finding |
|---|---|---|---|
| S-1 | **High** | fix in patch, not deployed | **A withdrawal after `unfollow()` counts as loss.** `FollowerVault.withdraw` books `netFlow` only while `following`. After `unfollow()`, `lossIn(epochSeen)` = start + flows − *live* equity, so withdrawing the remaining equity turns it all into "loss". `claimFor` caps a payout at min(pro-rata share, loss), and the loss cap is the only thing that stops a vault with no real loss from collecting the pot. Impact: a leader can breach on purpose and then claim through their own follower vault. The pot (their bond plus **underwriters' deposits** plus any slashed fee escrow) goes to that vault instead of to the reserve. Honest followers' shares are not reduced. `test_KNOWN_S1_…` shows a 300 AUSD pot paid against a 63.75 AUSD real loss. Fix: book flows whenever `epochSeen != 0`. |
| S-2 | Medium | fix in patch, not deployed | **Per-epoch vault data is keyed by epoch number only.** Epoch numbers repeat across leaders, so after switching leaders a vault's `netFlow[e]`, `startEquity[e]` and `endEquity[e]` can still hold the previous leader's values, which inflates `lossIn(e)`. Payouts stay bounded by the pro-rata share, as in S-1. Fix: reset `netFlow[e]` when epoch e is first seen, and tag each epoch with its leader (`epochLeader[e]`); `lossIn` returns 0 for data from another leader. |
| S-3 | Medium | fix in patch, not deployed | **UnderwriterPool share math.** (a) After a breach drains the pool to 0, the old shares remain, so the next depositor receives `amount` shares next to them and loses 2/3 of the deposit in the test. (b) Classic first-depositor donation attack: a 1-wei deposit plus a 100 AUSD donation takes 25 AUSD of a 150 AUSD deposit. Fix: OpenZeppelin-style virtual offset (1e3 virtual shares and assets, still 1:1 at the start), with payouts capped at real assets. |
| S-4 | Low | fix in patch, not deployed | **The underwriter unlock never expires.** After `unlockEpoch`, a pending withdrawal stays valid forever, so an underwriter keeps earning fees while holding an option to leave the moment a breach looks likely. Fix: withdraw only during the unlock epoch, and re-request after that. |

### Known design limits (not bugs, documented)
- **Checkpoint timing.** A breach is only seen when someone calls `checkpoint()`, a trade runs, or an epoch rolls. A drawdown that recovers between checkpoints is never seen. The keeper checkpoints every tick, and anyone can call it.
- **Real loss can be manufactured.** The loss cap (S-1) is measured on the vault's real Perpl equity. A leader could still wash-trade their own sybil vault into a real loss against an account they control. Bond deterrence assumes this costs more than it pays (fees and slippage on Perpl).
- **BreachMarket insider.** The leader can buy DOWN and then breach on purpose. Their profit is DOWN size − bond. Solvency is unaffected: the market is fully collateralised and settles from LeaderBook state only. Buyers should read DOWN prices as including this risk.
- **Admin.** `CopasRegistry.admin` can change risk parameters for future actions (fee caps are enforced: protocol ≤ 50%), add markets and swap factories. It cannot move user funds. It is a single key on testnet.

### Slither triage (all false positives or accepted)
| Detector | Count | Verdict |
|---|---|---|
| unchecked-transfer | 19 | FP for AUSD: it reverts on failure and does not return false. `IERC20Min` is only ever the registry's AUSD. |
| reentrancy-no-eth / benign / events | ~50 | FP. External calls go only to the Perpl exchange, AUSD, and registry-verified LeaderBook, FollowerVault and UnderwriterPool contracts. None of them hand control to an untrusted address. |
| divide-before-multiply (`_touchEpoch` fee split) | 2 | Accepted. It rounds dust in the protocol's favour. |
| incorrect-equality (`UnderwriterPool`) | 3 | FP: zero checks on share totals. Superseded by the S-3 patch. |
| unused-return (`execOrder`, `position`, `approve`) | 10 | Accepted. IOC fills are measured by the next sync and checkpoint, not by the return value. |
| missing-zero-check, events-access, timestamp | 9 | Accepted (testnet admin setters). Epoch timing is meant to depend on the timestamp. |
