import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alchemyTxHashes, chunkRanges, ddAlert, feedbackFor, leaderForAccount, needsUnwind, shouldCheckpoint, shouldRoll,
  verifyAlchemySignature, vaultsToSync, leaderTickAction, vaultSkipReason, STATUS, type Leader, type LeaderTickView, type Vault,
} from '../src/logic.js';

const L1 = '0x1111111111111111111111111111111111111111';
const L2 = '0x2222222222222222222222222222222222222222';
const leader = (o: Partial<Leader> = {}): Leader => ({ address: L1, accountId: 7n, status: STATUS.Active, epoch: 1n, epochEnd: 1000n, maxDDbps: 1500, ...o });
const vault = (address: string, o: Partial<Vault> = {}): Vault => ({ address: address as any, leader: L1, following: true, paused: false, accountId: 9n, ...o });

describe('which vaults to sync for a leader log', () => {
  it('maps a Perpl accountId to its leader', () => {
    const ls = [leader(), leader({ address: L2, accountId: 8n })];
    expect(leaderForAccount(8n, ls)?.address).toBe(L2);
    expect(leaderForAccount(99n, ls)).toBeUndefined();
    expect(leaderForAccount(0n, [leader({ accountId: 0n })])).toBeUndefined(); // unfunded leader never matches
  });
  it('only following vaults of that leader, case-insensitive', () => {
    const vs = [
      vault('0xa000000000000000000000000000000000000001'),
      vault('0xa000000000000000000000000000000000000002', { following: false }),
      vault('0xa000000000000000000000000000000000000003', { leader: L2 }),
      vault('0xa000000000000000000000000000000000000004', { leader: L1.toUpperCase().replace('0X', '0x') as any }),
      vault('0xa000000000000000000000000000000000000005', { leader: null }),
    ];
    expect(vaultsToSync(L1, vs)).toEqual(['0xa000000000000000000000000000000000000001', '0xa000000000000000000000000000000000000004']);
  });
});

describe('epoch decisions', () => {
  it('rolls only after epochEnd of a started epoch', () => {
    expect(shouldRoll(leader(), 999n)).toBe(false);
    expect(shouldRoll(leader(), 1000n)).toBe(true);
    expect(shouldRoll(leader({ epoch: 0n }), 5000n)).toBe(false);
  });
  it('checkpoints only active, started, funded leaders', () => {
    expect(shouldCheckpoint(leader())).toBe(true);
    expect(shouldCheckpoint(leader({ status: STATUS.Breached }))).toBe(false);
    expect(shouldCheckpoint(leader({ epoch: 0n }))).toBe(false);
    expect(shouldCheckpoint(leader({ accountId: 0n }))).toBe(false);
  });
  it('unwinds positions whose target is now zero', () => {
    const base = { vaultLot: 5n, leaderLot: 10n, leaderActive: true, following: true, paused: false };
    expect(needsUnwind(base)).toBe(false);
    expect(needsUnwind({ ...base, vaultLot: 0n, leaderActive: false })).toBe(false);
    expect(needsUnwind({ ...base, leaderActive: false })).toBe(true); // breached / unbonded
    expect(needsUnwind({ ...base, paused: true })).toBe(true); // stop-loss
    expect(needsUnwind({ ...base, following: false })).toBe(true);
    expect(needsUnwind({ ...base, leaderLot: 0n })).toBe(true);
    expect(needsUnwind({ ...base, leaderLot: -10n })).toBe(true); // leader flipped
  });
  it('8004 feedback: +100 clean, -100 tagged breach', () => {
    expect(feedbackFor(false, 0)).toEqual({ value: 100n, tag1: 'copas', tag2: 'epoch-clean' });
    expect(feedbackFor(true, 1)).toEqual({ value: -100n, tag1: 'copas', tag2: 'breach-drawdown' });
    expect(feedbackFor(true, 2).tag2).toBe('breach-leverage');
  });
});

describe('alert thresholds', () => {
  it('warns at 80% of the mandate, breach above it', () => {
    expect(ddAlert(1199, 1500)).toBeNull();
    expect(ddAlert(1200, 1500)).toBe('warn');
    expect(ddAlert(1500, 1500)).toBe('warn'); // contract breaches only on dd > max
    expect(ddAlert(1501, 1500)).toBe('breach');
    expect(ddAlert(500, 0)).toBeNull();
    expect(ddAlert(900, 1000, 0.9)).toBe('warn');
  });
});

describe('log chunking', () => {
  it('splits into <=100 block inclusive ranges', () => {
    expect(chunkRanges(1n, 250n, 100n)).toEqual([[1n, 100n], [101n, 200n], [201n, 250n]]);
    expect(chunkRanges(5n, 5n, 100n)).toEqual([[5n, 5n]]);
    expect(chunkRanges(6n, 5n, 100n)).toEqual([]);
  });
});

describe('Alchemy signature', () => {
  const key = 'whsec_test';
  const body = JSON.stringify({ event: { network: 'MONAD_TESTNET', activity: [{ hash: '0xabc' }, { hash: '0xabc' }, { hash: '0xdef' }] } });
  const sig = createHmac('sha256', key).update(body).digest('hex');
  it('accepts a valid HMAC-SHA256 of the raw body', () => expect(verifyAlchemySignature(body, sig, key)).toBe(true));
  it('rejects tampering, wrong key, missing or garbage header', () => {
    expect(verifyAlchemySignature(body + ' ', sig, key)).toBe(false);
    expect(verifyAlchemySignature(body, sig, 'other')).toBe(false);
    expect(verifyAlchemySignature(body, undefined, key)).toBe(false);
    expect(verifyAlchemySignature(body, 'zz', key)).toBe(false);
    expect(verifyAlchemySignature(body, sig, '')).toBe(false);
  });
  it('extracts unique tx hashes', () => expect(alchemyTxHashes(JSON.parse(body))).toEqual(['0xabc', '0xdef']));
});

describe('one-shot tick decisions', () => {
  const lv = (o: Partial<LeaderTickView> = {}): LeaderTickView => ({ epoch: 1n, epochEnd: 1000n, status: STATUS.Active, accountId: 7n, unitPrice: 2n, lastUnitPrice: 1n, priceValid: true, ...o });
  it('rolls an ended epoch (even when breached), else checkpoints only on a price move', () => {
    expect(leaderTickAction(lv(), 1000n).action).toBe('rollEpoch');
    expect(leaderTickAction(lv({ status: STATUS.Breached }), 1200n).action).toBe('rollEpoch');
    expect(leaderTickAction(lv(), 999n).action).toBe('checkpoint');
    expect(leaderTickAction(lv({ unitPrice: 1n }), 999n).action).toBeNull();
    expect(leaderTickAction(lv({ priceValid: false }), 999n).action).toBeNull();
    expect(leaderTickAction(lv({ status: STATUS.Breached }), 999n).action).toBeNull();
    expect(leaderTickAction(lv({ accountId: 0n }), 999n).action).toBeNull();
    expect(leaderTickAction(lv({ epoch: 0n }), 5000n).action).toBeNull();
  });
  it('skips vaults with nothing to copy or unwind', () => {
    expect(vaultSkipReason(vault('0xa1'))).toBeNull();
    expect(vaultSkipReason(vault('0xa1', { following: false }))).toBeNull(); // may still hold a position to unwind
    expect(vaultSkipReason(vault('0xa1', { following: false, accountId: 0n }))).not.toBeNull();
    expect(vaultSkipReason(vault('0xa1', { leader: null }))).not.toBeNull();
  });
});
