import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeFunctionResult, encodeFunctionData, getAddress, parseEventLogs, zeroAddress, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { ABI, cfg, log, type Deployments } from './config.js';
import { client } from './chain.js';
import type { Signer } from './signer.js';
import { alert, alertsSent, recentAlerts, sendChannel } from './alerts.js';
import { feedbackCall } from './erc8004.js';
import { marketMake } from './mm.js';
import {
  BREACH_REASON, CHANNEL_EVENTS, STATUS, channelMessage, chunkRanges, ddAlert, leaderForAccount, leaderTickAction, vaultSkipReason, needsUnwind, shouldCheckpoint, shouldRoll, vaultsToSync,
  type Leader, type Vault,
} from './logic.js';

// ---------------------------------------------------------------- events we listen to
const pick = (abi: readonly any[], names: string[]) => abi.filter((x) => x.type === 'event' && names.includes(x.name)) as AbiEvent[];
const POSITION_EVENTS = [
  'PositionOpened', 'PositionOpenedV2', 'PositionIncreased', 'PositionIncreasedV2', 'PositionDecreased', 'PositionClosed',
  'PositionInverted', 'PositionLiquidated', 'PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2',
  'PositionUnwoundWithoutPayment', 'PositionUnwoundWithoutPaymentV2',
];
export const EVENTS: AbiEvent[] = [
  ...pick(ABI.exchange, POSITION_EVENTS),
  ...pick(ABI.registry, ['LeaderCreated', 'VaultCreated']),
  ...pick(ABI.leader, ['Checkpoint', 'Breached', 'EpochRolled', 'UnbondRequested', 'FollowerRegistered', 'FollowerUnregistered']),
  ...pick(ABI.vault, ['Followed', 'Unfollowed', 'StopLoss']),
];
const VAULT_CREATED = pick(ABI.registry, ['VaultCreated'])[0];
const CHANNEL = [...pick(ABI.registry, ['LeaderCreated']), ...pick(ABI.leader, CHANNEL_EVENTS.filter((e) => e !== 'LeaderCreated'))];
/** ponytail: a tick more than this many blocks behind (~1h at 0.4 s) skips the gap instead of replaying it into the channel. */
const CHANNEL_MAX_LAG = 10_000n;

type DecodedLog = Log<bigint, number, false> & { eventName: string; args: Record<string, any> };
type Job = {
  key: string; kind: 'sync' | 'checkpoint' | 'rollEpoch' | 'touch' | 'settle' | 'feedback';
  to: Address; data: Hex; fillBlock?: bigint;
  skipIf?: (ret: Hex | undefined) => Promise<boolean>;
  onDone?: () => void | Promise<void>;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const lc = (a: string) => a.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Keeper {
  leaders = new Map<string, Leader>();
  vaults = new Map<string, Vault>();
  markets: bigint[] = [];
  cursor = 0n; // last block whose logs are processed
  vaultCursor = 0n; // last block scanned for VaultCreated
  alertCursor = 0n; // last block announced to the Telegram channel (tick mode)
  head = 0n;
  feedbackDone = new Set<string>();
  private ddWarned = new Set<string>();
  private seen = new Set<string>();
  private inflight = new Map<string, boolean>(); // key -> rerun requested
  private lastCheckpointAt = 0n;
  private lastUnwindAt = 0n;
  private stateFile = resolve(cfg.dataDir, `state-${cfg.chainId}.json`);
  private wake: () => void = () => {};
  private pending = new Set<Promise<void>>();
  /** Set by tick(): every job's outcome, for the run summary. */
  journal?: { kind: string; to: Address; outcome: 'sent' | 'skipped' | 'failed' | 'dry-run'; detail: string }[];
  dryRun = false;

  m = {
    startedAt: new Date().toISOString(), syncsSent: 0, syncsSkipped: 0, checkpoints: 0, rolls: 0, touches: 0, settles: 0,
    feedbacks: 0, txFailed: 0, breachesSeen: 0, leaderFills: 0,
    latency: [] as number[], // blocks between leader fill and follower sync receipt
    recentTx: [] as { kind: string; to: string; hash: string; block?: string; ok: boolean; err?: string }[],
  };

  constructor(readonly dep: Deployments, readonly signer: Signer) {}

  // ---------------------------------------------------------------- state
  private load() {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.vaultCursor = BigInt(s.vaultCursor ?? 0);
      this.alertCursor = BigInt(s.alertCursor ?? 0);
      for (const v of s.vaults ?? []) this.vaults.set(lc(v), { address: getAddress(v), leader: null, following: false, paused: false, accountId: 0n });
      for (const k of s.feedbackDone ?? []) this.feedbackDone.add(k);
    } catch { /* first run */ }
  }
  private save() {
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({
      cursor: this.cursor.toString(), vaultCursor: this.vaultCursor.toString(), alertCursor: this.alertCursor.toString(),
      vaults: [...this.vaults.values()].map((v) => v.address), feedbackDone: [...this.feedbackDone],
    }, null, 2));
  }

  // ---------------------------------------------------------------- reads
  private read<T>(address: Address, abi: any, functionName: string, args: any[] = []) {
    return client.readContract({ address, abi, functionName, args }) as Promise<T>;
  }

  async refreshLeader(addr: Address) {
    const [accountId, status, epoch, epochEnd, mandate] = await Promise.all([
      this.read<bigint>(addr, ABI.leader, 'accountId'),
      this.read<number>(addr, ABI.leader, 'status'),
      this.read<bigint>(addr, ABI.leader, 'epoch'),
      this.read<bigint>(addr, ABI.leader, 'epochEnd'),
      this.read<{ maxDDbps: number }>(addr, ABI.leader, 'mandate'),
    ]);
    const l: Leader = { address: getAddress(addr), accountId, status: Number(status), epoch, epochEnd: BigInt(epochEnd), maxDDbps: Number(mandate.maxDDbps) };
    this.leaders.set(lc(addr), l);
    return l;
  }

  async refreshVault(addr: Address) {
    const [leader, following, paused, accountId] = await Promise.all([
      this.read<Address>(addr, ABI.vault, 'leader'),
      this.read<boolean>(addr, ABI.vault, 'following'),
      this.read<boolean>(addr, ABI.vault, 'paused'),
      this.read<bigint>(addr, ABI.vault, 'accountId'),
    ]);
    const v: Vault = { address: getAddress(addr), leader: leader === zeroAddress ? null : getAddress(leader), following, paused, accountId };
    this.vaults.set(lc(addr), v);
    return v;
  }

  async refreshAll() {
    const n = await this.read<bigint>(this.dep.registry, ABI.registry, 'leaderCount');
    const addrs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => this.read<Address>(this.dep.registry, ABI.registry, 'leaderBooks', [BigInt(i)])));
    const mk = await this.read<{ perpId: number }[]>(this.dep.registry, ABI.registry, 'markets');
    this.markets = mk.map((x) => BigInt(x.perpId));
    await Promise.all([...addrs.map((a) => this.refreshLeader(a).catch((e) => log('warn', 'refreshLeader failed', { a, err: String(e) }))),
      ...[...this.vaults.values()].map((v) => this.refreshVault(v.address).catch((e) => log('warn', 'refreshVault failed', { v: v.address, err: String(e) })))]);
  }

  async lot(perpId: bigint, accountId: bigint): Promise<bigint> {
    if (accountId === 0n) return 0n;
    const [p] = await this.read<[{ positionType: number; lotLNS: bigint }, bigint, boolean]>(this.dep.exchange, ABI.exchange, 'getPosition', [perpId, accountId]);
    return p.positionType === 0 ? p.lotLNS : -p.lotLNS;
  }

  // ---------------------------------------------------------------- tx jobs
  /** Simulate first (reverts = nothing to do, which makes every job idempotent), then send and wait. Never throws. */
  enqueue(job: Job) {
    if (this.inflight.has(job.key)) { this.inflight.set(job.key, true); return; }
    this.inflight.set(job.key, false);
    const note = (outcome: 'sent' | 'skipped' | 'failed' | 'dry-run', detail: string) => this.journal?.push({ kind: job.kind, to: job.to, outcome, detail });
    const p = (async () => {
      try {
        let ret: Hex | undefined;
        try {
          ret = (await client.call({ account: this.signer.address, to: job.to, data: job.data })).data;
        } catch (e: any) {
          log(job.kind === 'feedback' ? 'warn' : 'debug', 'skip: would revert', { kind: job.kind, to: job.to, err: e?.shortMessage ?? String(e) });
          note('skipped', `simulation reverts: ${(e?.shortMessage ?? String(e)).split('\n')[0].slice(0, 160)}`);
          return;
        }
        if (job.skipIf && (await job.skipIf(ret))) { if (job.kind === 'sync') this.m.syncsSkipped++; note('skipped', job.kind === 'sync' ? 'position already equals target' : 'no state change'); return; }
        if (this.dryRun) { note('dry-run', 'simulation ok, would send'); return; }
        const hash = await this.signer.send(job.to, job.data);
        const r = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
        const ok = r.status === 'success';
        this.m.recentTx.unshift({ kind: job.kind, to: job.to, hash, block: r.blockNumber.toString(), ok });
        this.m.recentTx.length = Math.min(this.m.recentTx.length, 30);
        log(ok ? 'info' : 'warn', 'tx', { kind: job.kind, to: job.to, hash, block: r.blockNumber, ok });
        note(ok ? 'sent' : 'failed', hash);
        if (!ok) { this.m.txFailed++; return; }
        const counter = ({ sync: 'syncsSent', checkpoint: 'checkpoints', rollEpoch: 'rolls', touch: 'touches', settle: 'settles', feedback: 'feedbacks' } as const)[job.kind];
        this.m[counter]++;
        if (job.fillBlock !== undefined) { this.m.latency.push(Number(r.blockNumber - job.fillBlock)); if (this.m.latency.length > 200) this.m.latency.shift(); }
        await job.onDone?.();
      } catch (e: any) {
        this.m.txFailed++;
        this.m.recentTx.unshift({ kind: job.kind, to: job.to, hash: '', ok: false, err: (e?.shortMessage ?? String(e)).slice(0, 300) });
        this.m.recentTx.length = Math.min(this.m.recentTx.length, 30);
        log('error', 'tx failed', { kind: job.kind, to: job.to, err: e?.shortMessage ?? String(e), body: e?.error });
        note('failed', (e?.shortMessage ?? String(e)).split('\n')[0].slice(0, 200));
      } finally {
        const rerun = this.inflight.get(job.key);
        this.inflight.delete(job.key);
        if (rerun) this.enqueue(job);
      }
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Wait until every queued job (and its reruns) has finished. */
  async drain() { while (this.pending.size) await Promise.all(this.pending); }

  private call(abi: any, functionName: string, args: any[] = []) { return encodeFunctionData({ abi, functionName, args }); }

  sync(vault: Vault, perpId: bigint, fillBlock?: bigint) {
    this.enqueue({
      key: `sync:${lc(vault.address)}:${perpId}`, kind: 'sync', to: vault.address, data: this.call(ABI.vault, 'sync', [perpId]), fillBlock,
      // sync is a no-op when the simulated target equals the current lot: don't pay gas for it
      skipIf: async (ret) => {
        const target = decodeFunctionResult({ abi: ABI.vault, functionName: 'sync', data: ret! }) as bigint;
        return target === (await this.lot(perpId, vault.accountId));
      },
    });
  }
  checkpoint(l: Leader) {
    this.enqueue({ key: `cp:${lc(l.address)}`, kind: 'checkpoint', to: l.address, data: this.call(ABI.leader, 'checkpoint') });
  }
  roll(l: Leader) {
    this.enqueue({ key: `roll:${lc(l.address)}`, kind: 'rollEpoch', to: l.address, data: this.call(ABI.leader, 'rollEpoch'), onDone: () => this.refreshLeader(l.address).then(() => {}) });
  }
  touch(v: Vault, l: Leader) {
    this.enqueue({
      key: `touch:${lc(v.address)}`, kind: 'touch', to: v.address, data: this.call(ABI.vault, 'touch'),
      skipIf: async () => (await this.read<bigint>(v.address, ABI.vault, 'epochSeen')) === (await this.read<bigint>(l.address, ABI.leader, 'epoch')),
    });
  }
  settle(leader: Address, epoch: bigint) {
    if (!cfg.enableSettle) return;
    // reverts (series missing / already settled / epoch running) are skipped by the simulation
    this.enqueue({ key: `settle:${lc(leader)}:${epoch}`, kind: 'settle', to: this.dep.breachMarket, data: this.call(ABI.breachMarket, 'settle', [leader, epoch]) });
  }
  async feedback(leader: Address, epoch: bigint) {
    const k = `${lc(leader)}:${epoch}`;
    if (!cfg.enable8004 || this.feedbackDone.has(k)) return;
    const c = await feedbackCall(client, this.dep.agentRegistry, leader, epoch);
    if (!c) return;
    log('info', '8004 feedback', { leader, epoch, agentId: c.agentId, tag2: c.tag2 });
    this.enqueue({ key: `fb:${k}`, kind: 'feedback', to: c.to, data: c.data, onDone: () => { this.feedbackDone.add(k); this.save(); } });
  }

  // ---------------------------------------------------------------- log handling
  async processLog(lg: DecodedLog) {
    const id = `${lg.transactionHash}:${lg.logIndex}`;
    if (this.seen.has(id)) return; // poller and Alchemy webhook can both deliver the same log
    this.seen.add(id);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);

    const addr = lc(lg.address);
    const a = lg.args;
    const block = lg.blockNumber ?? this.head;

    if (addr === lc(this.dep.exchange)) {
      if (!POSITION_EVENTS.includes(lg.eventName)) return;
      const l = leaderForAccount(BigInt(a.accountId ?? a.posAccountId), this.leaders.values());
      if (!l) return;
      this.m.leaderFills++;
      const perpId = BigInt(a.perpId);
      const verb = lg.eventName.startsWith('PositionOpened') ? 'opened' : lg.eventName === 'PositionClosed' ? 'closed' : lg.eventName === 'PositionLiquidated' ? 'was liquidated in' : null;
      if (verb) await alert(verb === 'opened' ? 'position-opened' : 'position-closed', `Leader ${short(l.address)} ${verb} a position on perp ${perpId} (block ${block})`, [l.address]);
      for (const v of vaultsToSync(l.address, this.vaults.values())) this.sync(this.vaults.get(lc(v))!, perpId, block);
      this.checkpoint(l);
      return;
    }

    if (addr === lc(this.dep.registry)) {
      if (lg.eventName === 'LeaderCreated') await this.refreshLeader(a.leaderBook);
      if (lg.eventName === 'VaultCreated') await this.refreshVault(a.vault);
      return;
    }

    const l = this.leaders.get(addr);
    if (l) {
      switch (lg.eventName) {
        case 'Checkpoint': {
          const lvl = ddAlert(Number(a.ddBps), l.maxDDbps, cfg.ddAlertFraction);
          const k = `${addr}:${a.epoch}`;
          if (lvl === 'warn' && !this.ddWarned.has(k)) {
            this.ddWarned.add(k);
            await alert('dd-warning', `Leader ${short(l.address)} drawdown ${(Number(a.ddBps) / 100).toFixed(2)}% reached ${Math.round(cfg.ddAlertFraction * 100)}% of its ${(l.maxDDbps / 100).toFixed(2)}% mandate (epoch ${a.epoch})`, [l.address, ...vaultsToSync(l.address, this.vaults.values())]);
          }
          break;
        }
        case 'Breached': {
          this.m.breachesSeen++;
          const followers = vaultsToSync(l.address, this.vaults.values());
          await alert('breach', `BREACH: leader ${short(l.address)} broke its mandate (${BREACH_REASON[Number(a.reason)]}) in epoch ${a.epoch}. Bond slashed: ${Number(a.pot) / 1e6} AUSD.`, [l.address, ...followers]);
          await alert('claim-available', `Claim available: followers of ${short(l.address)} active in epoch ${a.epoch} can claim from a ${Number(a.pot) / 1e6} AUSD pot (FollowerVault.claim).`, [l.address, ...followers]);
          await this.refreshLeader(l.address);
          await this.unwindScan([...this.vaults.values()].filter((v) => lc(v.leader ?? '') === addr));
          this.settle(l.address, BigInt(a.epoch));
          break;
        }
        case 'EpochRolled': {
          const nl = await this.refreshLeader(l.address);
          for (const v of this.vaults.values()) if (v.following && lc(v.leader ?? '') === addr) this.touch(v, nl);
          const finished = BigInt(a.epoch) - 1n;
          if (finished > 0n) { this.settle(l.address, finished); await this.feedback(l.address, finished); }
          break;
        }
        case 'UnbondRequested':
          await alert('unbond-requested', `Leader ${short(l.address)} requested to unbond ${Number(a.amount) / 1e6} AUSD (unlocks at epoch ${a.unlockEpoch}). Protection drops after that.`, [l.address, ...vaultsToSync(l.address, this.vaults.values())]);
          break;
        case 'FollowerRegistered':
        case 'FollowerUnregistered':
          await this.refreshVault(a.vault);
          break;
      }
      return;
    }

    const v = this.vaults.get(addr);
    if (v) {
      if (lg.eventName === 'StopLoss') {
        await alert('stop-loss', `Vault ${short(v.address)} hit its stop-loss in epoch ${a.epoch}: copying paused, positions unwinding.`, [v.address, v.leader ?? '']);
        await this.unwindScan([await this.refreshVault(v.address)]);
      } else if (lg.eventName === 'Followed' || lg.eventName === 'Unfollowed') {
        await this.refreshVault(v.address);
      }
    }
  }

  /** Decodes raw receipt logs (Alchemy webhook path) through the same handler. */
  async processReceipt(hash: Hex) {
    const r = await client.getTransactionReceipt({ hash });
    for (const lg of parseEventLogs({ abi: EVENTS, logs: r.logs, strict: false })) await this.processLog(lg as any);
  }

  // ---------------------------------------------------------------- periodic jobs
  /** sync(...) every (vault, market) whose position should now be zero: post-breach, stop-loss, unfollow, leader flat. */
  async unwindScan(vaults: Vault[]) {
    const leaderLots = new Map<string, bigint>();
    for (const v of vaults) {
      if (!v.leader || v.accountId === 0n) continue;
      const l = this.leaders.get(lc(v.leader)) ?? (await this.refreshLeader(v.leader));
      await Promise.all(this.markets.map(async (perpId) => {
        try {
          const vaultLot = await this.lot(perpId, v.accountId);
          if (vaultLot === 0n) return;
          const lk = `${lc(l.address)}:${perpId}`;
          if (!leaderLots.has(lk)) leaderLots.set(lk, await this.lot(perpId, l.accountId));
          if (needsUnwind({ vaultLot, leaderLot: leaderLots.get(lk)!, leaderActive: l.status === STATUS.Active, following: v.following, paused: v.paused })) this.sync(v, perpId);
        } catch (e) { log('warn', 'unwind scan failed', { vault: v.address, perpId, err: String(e) }); }
      }));
    }
  }

  async periodic() {
    const blk = await client.getBlock({ blockTag: 'latest' });
    if (blk.number - this.lastCheckpointAt >= cfg.checkpointEvery) {
      this.lastCheckpointAt = blk.number;
      await this.refreshAll();
      for (const l of this.leaders.values()) if (shouldCheckpoint(l)) this.checkpoint(l);
    }
    for (const l of this.leaders.values()) if (shouldRoll(l, blk.timestamp)) this.roll(l);
    if (blk.number - this.lastUnwindAt >= cfg.unwindEvery) {
      this.lastUnwindAt = blk.number;
      await this.unwindScan([...this.vaults.values()]);
    }
  }

  // ---------------------------------------------------------------- main loop
  private async getLogsChunked(from: bigint, to: bigint, events: AbiEvent[], address?: Address | Address[], parallel = 1) {
    const ranges = chunkRanges(from, to, cfg.logChunk);
    const out: DecodedLog[] = [];
    for (let i = 0; i < ranges.length; i += parallel) {
      const batch = await Promise.all(ranges.slice(i, i + parallel).map(async ([f, t]) => {
        // public testnet RPC: 25 req/s, so back off and retry instead of failing a long backfill
        for (let n = 1; ; n++) {
          try { return await client.getLogs({ address, events, fromBlock: f, toBlock: t, strict: false }); }
          catch (e) { if (n >= 6) throw e; await sleep(1000 * n); }
        }
      }));
      for (const b of batch) out.push(...(b as any));
    }
    return out;
  }

  /** One-time (then incremental) VaultCreated backfill so restarts know every vault. */
  async discoverVaults() {
    const head = await client.getBlockNumber();
    const from = this.vaultCursor ? this.vaultCursor + 1n : cfg.startBlock ? BigInt(cfg.startBlock) : BigInt(this.dep.block);
    if (from <= head) {
      log('info', 'backfilling VaultCreated', { from, head, chunks: chunkRanges(from, head, cfg.logChunk).length });
      for (const lg of await this.getLogsChunked(from, head, [VAULT_CREATED], this.dep.registry, 8)) {
        const v = getAddress(lg.args.vault);
        if (!this.vaults.has(lc(v))) this.vaults.set(lc(v), { address: v, leader: null, following: false, paused: false, accountId: 0n });
      }
    }
    this.vaultCursor = head;
    this.cursor = head; // live processing starts here; periodic jobs heal anything missed while down
    this.save();
  }

  async step() {
    this.head = await client.getBlockNumber();
    if (this.head > this.cursor) {
      for (const [f, t] of chunkRanges(this.cursor + 1n, this.head, cfg.logChunk)) {
        const logs = await this.getLogsChunked(f, t, EVENTS);
        for (const lg of logs) {
          try { await this.processLog(lg); } catch (e) { log('error', 'processLog failed', { tx: lg.transactionHash, ev: lg.eventName, err: String(e) }); }
        }
        this.cursor = t;
        this.vaultCursor = t;
      }
      this.save();
    }
    await this.periodic();
  }

  async start() {
    this.load();
    await this.discoverVaults();
    await this.refreshAll();
    log('info', 'keeper started', { chainId: cfg.chainId, signer: this.signer.address, mode: this.signer.mode, leaders: this.leaders.size, vaults: this.vaults.size, markets: this.markets, cursor: this.cursor });
    if (cfg.wsUrl) client.watchBlockNumber({ onBlockNumber: () => this.wake(), onError: (e) => log('warn', 'ws error', { err: String(e) }) });
    for (;;) {
      try { await this.step(); } catch (e: any) { log('error', 'step failed', { err: e?.shortMessage ?? String(e) }); }
      // WS mode wakes on every new head; HTTP mode polls. Either way at most one step runs at a time.
      await new Promise<void>((r) => { const t = setTimeout(r, cfg.wsUrl ? 10_000 : cfg.pollMs); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }

  // ---------------------------------------------------------------- one-shot mode (`pnpm tick`, GitHub Actions cron)
  /**
   * Read everything, send only the txs that change state, wait for them, report, return an exit code.
   * Order: rollEpoch -> (settle/feedback of finished epochs) -> checkpoint -> touch -> sync every (vault, market) -> DOWN market maker (src/mm.ts).
   */
  async tick(): Promise<number> {
    const t0 = Date.now();
    this.journal = [];
    this.dryRun = ['1', 'true'].includes(String(process.env.KEEPER_DRY_RUN).toLowerCase());
    const decisions: { what: string; decision: string }[] = [];
    this.load();
    await this.discoverVaults(); // incremental VaultCreated scan from the cached cursor
    await this.refreshAll();
    const blk = await client.getBlock({ blockTag: 'latest' });
    log('info', 'tick', { signer: this.signer.address, mode: this.signer.mode, block: blk.number, leaders: this.leaders.size, vaults: this.vaults.size, markets: this.markets, dryRun: this.dryRun });

    const views = async () => Promise.all([...this.leaders.values()].map(async (l) => {
      const [[unitPrice, priceValid], lastUnitPrice] = await Promise.all([
        this.read<[bigint, boolean]>(l.address, ABI.leader, 'unitPrice'),
        this.read<bigint>(l.address, ABI.leader, 'lastUnitPrice'),
      ]);
      return { l, ...leaderTickAction({ ...l, unitPrice, priceValid, lastUnitPrice }, blk.timestamp) };
    }));

    // 1. roll ended epochs first: everything else depends on the current epoch
    const rolled: { address: Address; finished: bigint }[] = [];
    for (const { l, action, why } of await views()) {
      if (action !== 'rollEpoch') continue;
      decisions.push({ what: `leader ${l.address}`, decision: `rollEpoch: ${why}` });
      rolled.push({ address: l.address, finished: l.epoch });
      this.roll(l);
    }
    await this.drain();
    if (rolled.length) await this.refreshAll();
    for (const r of rolled) { this.settle(r.address, r.finished); await this.feedback(r.address, r.finished); }

    // 2. checkpoints
    for (const { l, action, why } of await views()) {
      if (rolled.some((r) => r.address === l.address) && action !== 'checkpoint') continue; // rollEpoch already checkpointed
      decisions.push({ what: `leader ${l.address}`, decision: action ? `${action}: ${why}` : `no tx: ${why}` });
      if (action === 'checkpoint') this.checkpoint(l);
    }
    await this.drain();

    // 3. vaults: touch (epoch bookkeeping) then sync every market; simulation + target==lot check skip the no-ops
    for (const v of this.vaults.values()) {
      const skip = vaultSkipReason(v);
      decisions.push({ what: `vault ${v.address}`, decision: skip ? `no tx: ${skip}` : `following=${v.following} paused=${v.paused} leader=${v.leader}: simulate touch + sync(${this.markets.join(',')})` });
      if (skip) continue;
      const l = this.leaders.get(lc(v.leader!));
      if (v.following && l) this.touch(v, l);
    }
    await this.drain();
    for (const v of this.vaults.values()) if (!vaultSkipReason(v)) for (const perpId of this.markets) this.sync(v, perpId);
    await this.drain();
    // 4. DOWN market maker (own key, sequential txs; no-op without MM_PRIVATE_KEY)
    await marketMake(this.dep, [...this.leaders.values()], (await client.getBlock({ blockTag: 'latest' })).timestamp, { journal: this.journal, decisions, dryRun: this.dryRun })
      .catch((e) => this.journal!.push({ kind: 'mm', to: this.dep.breachMarket, outcome: 'failed', detail: String(e?.shortMessage ?? e).slice(0, 200) }));
    await this.announce();
    this.save();

    const failed = this.journal.filter((j) => j.outcome === 'failed').length;
    log('info', 'tick done', { ms: Date.now() - t0, sent: this.journal.filter((j) => j.outcome === 'sent').length, failed, journal: this.journal });
    this.writeSummary(blk.number, blk.timestamp, decisions, Date.now() - t0);
    return failed ? 1 : 0;
  }

  /**
   * Post LeaderCreated / Breached / EpochRolled / Claimed / FollowerRegistered since the last tick to TELEGRAM_CHAT_ID.
   * Without the env (or on the first run) the cursor just moves to head, so enabling it later never replays history.
   * The cursor only advances past a range once all its posts went out; a Telegram outage retries next tick. Never throws.
   */
  async announce() {
    const head = await client.getBlockNumber();
    const from = this.alertCursor + 1n;
    if (!cfg.telegramToken || !cfg.telegramChatId || !this.alertCursor || head - this.alertCursor > CHANNEL_MAX_LAG) {
      if (cfg.telegramToken && cfg.telegramChatId && this.alertCursor) log('warn', 'channel alerts: gap too large, skipping', { from, head });
      this.alertCursor = head;
      return;
    }
    if (from > head) return;
    const ex = cfg.chainId === 143 ? 'https://monadexplorer.com' : 'https://testnet.monadexplorer.com';
    let logs: DecodedLog[];
    try {
      logs = await this.getLogsChunked(from, head, CHANNEL, [this.dep.registry, ...[...this.leaders.values()].map((l) => l.address)], 4);
    } catch (e) { return log('warn', 'channel alerts: getLogs failed, retrying next tick', { from, head, err: String(e) }); }
    logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
    for (const lg of logs) {
      const text = channelMessage(lg, ex);
      if (!text) continue;
      try { await sendChannel(text); log('info', 'channel alert sent', { ev: lg.eventName, tx: lg.transactionHash }); }
      catch (e) {
        // resume from this block next tick (earlier posts in the same block may repeat, later ones are not lost)
        this.alertCursor = BigInt(lg.blockNumber) - 1n > this.alertCursor ? BigInt(lg.blockNumber) - 1n : this.alertCursor;
        return log('warn', 'channel alert failed, retrying next tick', { ev: lg.eventName, err: String(e) });
      }
    }
    this.alertCursor = head;
  }

  private writeSummary(block: bigint, ts: bigint, decisions: { what: string; decision: string }[], ms: number) {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    const ex = cfg.chainId === 143 ? 'https://monadexplorer.com' : 'https://testnet.monadexplorer.com';
    const a = (x: string) => `[\`${short(x)}\`](${ex}/address/${x})`;
    const rows = this.journal!.map((j) => `| ${j.kind} | ${a(j.to)} | ${j.outcome} | ${/^0x[0-9a-f]{64}$/i.test(j.detail) ? `[${short(j.detail)}](${ex}/tx/${j.detail})` : j.detail.replace(/\|/g, '/')} |`);
    appendFileSync(file, [
      `## Copas keeper tick (chain ${cfg.chainId})`,
      '',
      `Block ${block} (${new Date(Number(ts) * 1000).toISOString()}) · signer ${a(this.signer.address)} (${this.signer.mode}${this.signer.mode === 'PRIVY' && cfg.privy.sponsor ? ', gas sponsored' : ''}) · ${this.leaders.size} leaders, ${this.vaults.size} vaults, markets ${this.markets.join(', ')} · ${(ms / 1000).toFixed(1)}s${this.dryRun ? ' · **DRY RUN**' : ''}`,
      '',
      `### Transactions (${this.journal!.filter((j) => j.outcome === 'sent').length} sent)`,
      '',
      '| job | target | outcome | tx / reason |', '|---|---|---|---|',
      ...(rows.length ? rows : ['| - | - | - | nothing to simulate |']),
      '',
      '### Decisions',
      '',
      '| object | decision |', '|---|---|',
      ...decisions.map((d) => `| ${d.what.replace(/0x[0-9a-fA-F]{40}/g, (m) => a(m))} | ${d.decision.replace(/\|/g, '/')} |`),
      '',
    ].join('\n'));
  }

  metrics() {
    const lat = this.m.latency;
    const sorted = [...lat].sort((a, b) => a - b);
    return {
      chainId: cfg.chainId, signer: { mode: this.signer.mode, address: this.signer.address },
      lastBlock: this.head.toString(), processedBlock: this.cursor.toString(),
      leaders: this.leaders.size, vaults: this.vaults.size, inflight: this.inflight.size,
      ...this.m,
      latency: undefined,
      latencyBlocks: { samples: lat.length, last: lat.at(-1) ?? null, avg: lat.length ? +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(2) : null, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null },
      alertsSent, recentAlerts,
    };
  }
}
