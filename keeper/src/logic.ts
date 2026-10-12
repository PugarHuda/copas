// Pure decision logic. No I/O, no config: everything here is unit-tested.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Address, Hex } from 'viem';

export const STATUS = { Active: 0, Unbonded: 1, Breached: 2 } as const;
export const BREACH_REASON = ['none', 'drawdown', 'leverage', 'notional', 'market'] as const;

export type Leader = {
  address: Address;
  accountId: bigint; // Perpl account held by the LeaderBook (0 until first deposit)
  status: number;
  epoch: bigint;
  epochEnd: bigint;
  maxDDbps: number;
};

export type Vault = {
  address: Address;
  leader: Address | null;
  following: boolean;
  paused: boolean;
  accountId: bigint;
};

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Perpl Position* events all start with (uint256 perpId, uint256 accountId, ...) in non-indexed data. */
export function decodePositionData(data: Hex): { perpId: bigint; accountId: bigint } {
  return { perpId: BigInt('0x' + data.slice(2, 66)), accountId: BigInt('0x' + data.slice(66, 130)) };
}

/** Leader whose Perpl account just moved, if any. */
export function leaderForAccount(accountId: bigint, leaders: Iterable<Leader>): Leader | undefined {
  if (accountId === 0n) return undefined;
  for (const l of leaders) if (l.accountId === accountId) return l;
}

/** Vaults to `sync(perpId)` after the leader's position changed. Unfollowed vaults are unwound by the periodic scan. */
export function vaultsToSync(leader: Address, vaults: Iterable<Vault>): Address[] {
  const out: Address[] = [];
  for (const v of vaults) if (v.following && eq(v.leader, leader)) out.push(v.address);
  return out;
}

/** rollEpoch() only succeeds once block.timestamp >= epochEnd (and epoch has started). */
export function shouldRoll(l: Pick<Leader, 'epoch' | 'epochEnd'>, blockTs: bigint): boolean {
  return l.epoch > 0n && blockTs >= l.epochEnd;
}

/** checkpoint() is a no-op unless the leader is Active in a started epoch. */
export function shouldCheckpoint(l: Pick<Leader, 'epoch' | 'status' | 'accountId'>): boolean {
  return l.epoch > 0n && l.status === STATUS.Active && l.accountId !== 0n;
}

/** Vault holds a position its target would now put at 0: leader gone/breached, vault paused or unfollowed, leader flat or flipped. */
export function needsUnwind(a: { vaultLot: bigint; leaderLot: bigint; leaderActive: boolean; following: boolean; paused: boolean }): boolean {
  if (a.vaultLot === 0n) return false;
  if (!a.following || a.paused || !a.leaderActive || a.leaderLot === 0n) return true;
  return a.leaderLot > 0n !== a.vaultLot > 0n;
}

/** Drawdown alert level for a Checkpoint event. */
export function ddAlert(ddBps: number, maxDDbps: number, fraction = 0.8): 'breach' | 'warn' | null {
  if (maxDDbps <= 0) return null;
  if (ddBps > maxDDbps) return 'breach';
  if (ddBps >= maxDDbps * fraction) return 'warn';
  return null;
}

/** ERC-8004 feedback for a finished epoch: +100 clean, -100 breached, tagged with the reason. */
export function feedbackFor(breached: boolean, reason: number): { value: bigint; tag1: string; tag2: string } {
  if (!breached) return { value: 100n, tag1: 'copas', tag2: 'epoch-clean' };
  return { value: -100n, tag1: 'copas', tag2: `breach-${BREACH_REASON[reason] ?? 'unknown'}` };
}

/** Inclusive [from,to] split into ranges of at most `size` blocks (eth_getLogs limit). */
export function chunkRanges(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += size) out.push([s, s + size - 1n > to ? to : s + size - 1n]);
  return out;
}

/** Alchemy Notify: x-alchemy-signature = hex(HMAC-SHA256(signingKey, rawBody)). */
export function verifyAlchemySignature(rawBody: string | Buffer, signature: string | undefined, key: string): boolean {
  if (!signature || !key) return false;
  const want = createHmac('sha256', key).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(signature.trim(), 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Pull tx hashes out of an Alchemy ADDRESS_ACTIVITY payload. */
export function alchemyTxHashes(body: any): Hex[] {
  const acts: any[] = body?.event?.activity ?? [];
  return [...new Set(acts.map((a) => a?.hash).filter((h): h is Hex => typeof h === 'string' && h.startsWith('0x')))];
}

// ---------------------------------------------------------------- one-shot tick (`pnpm tick`)
export type LeaderTickView = Pick<Leader, 'epoch' | 'epochEnd' | 'status' | 'accountId'> & { unitPrice: bigint; lastUnitPrice: bigint; priceValid: boolean };

/** What a tick does with a leader. checkpoint() only writes state when the unit price moved (that's also the only way drawdown can breach). */
export function leaderTickAction(l: LeaderTickView, blockTs: bigint): { action: 'rollEpoch' | 'checkpoint' | null; why: string } {
  if (l.epoch === 0n) return { action: null, why: 'epoch not started' };
  if (shouldRoll(l, blockTs)) return { action: 'rollEpoch', why: `epoch ${l.epoch} ended (${blockTs - l.epochEnd}s ago)` };
  if (l.status !== STATUS.Active) return { action: null, why: `status ${['Active', 'Unbonded', 'Breached'][l.status] ?? l.status}, epoch ends in ${l.epochEnd - blockTs}s` };
  if (l.accountId === 0n) return { action: null, why: 'no Perpl account yet' };
  if (!l.priceValid) return { action: null, why: 'unit price invalid (no mark)' };
  if (l.unitPrice === l.lastUnitPrice) return { action: null, why: `unit price unchanged since last checkpoint, epoch ends in ${l.epochEnd - blockTs}s` };
  return { action: 'checkpoint', why: `unit price ${l.lastUnitPrice} -> ${l.unitPrice}` };
}

/** Reason to skip a vault entirely, or null to simulate sync(perpId) on every market (copy or unwind). */
export function vaultSkipReason(v: Vault): string | null {
  if (!v.leader) return 'no leader';
  if (!v.following && v.accountId === 0n) return 'not following and no Perpl account';
  return null;
}
