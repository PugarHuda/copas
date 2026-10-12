// G4 alerts. Who gets what: the alerts channel (TELEGRAM_CHAT_ID) gets every card; a chat that sent /watch <leader|vault> to
// @copas_monad_bot gets the events touching those addresses in a DM. Watch lists live in the bot's private Vercel Blob store
// (web/lib/tgWatch.ts, one blob per chat at tg/watch/<chatId>.json); the keeper only reads them (BLOB_READ_WRITE_TOKEN).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { get, list } from '@vercel/blob';
import { parseEventLogs, type Address, type Hex } from 'viem';
import { ABI, cfg, log } from './config.js';
import { client } from './chain.js';
import { BREACH_REASON } from './logic.js';

export type AlertKind = 'position-opened' | 'position-closed' | 'dd-warning' | 'breach' | 'claim-available' | 'unbond-requested' | 'stop-loss';

const WATCH_PREFIX = 'tg/watch/';

/** chatId -> watched addresses (lowercase). Empty without BLOB_READ_WRITE_TOKEN or when the store is unreachable. Never throws. */
export async function loadWatchers(token = process.env.BLOB_READ_WRITE_TOKEN): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!token) return out;
  try {
    // ponytail: one list + one get per watching chat each tick; fine to a few hundred chats, a single index blob after that
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: WATCH_PREFIX, cursor, token });
      await Promise.all(page.blobs.map(async (b) => {
        const r = await get(b.pathname, { access: 'private', useCache: false, token });
        if (r?.statusCode !== 200) return;
        const { addrs } = JSON.parse(await new Response(r.stream).text()) as { addrs?: string[] };
        if (addrs?.length) out.set(b.pathname.slice(WATCH_PREFIX.length, -'.json'.length), addrs.map((a) => a.toLowerCase()));
      }));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (e) { log('warn', 'watch lists unreadable', { err: String(e) }); }
  return out;
}

/** Chats watching any of `addrs`. */
export function watchersOf(watchers: Map<string, string[]>, addrs: string[]): string[] {
  const want = addrs.filter(Boolean).map((a) => a.toLowerCase());
  return [...watchers].filter(([, w]) => w.some((a) => want.includes(a))).map(([chat]) => chat);
}

export const recentAlerts: { t: string; kind: AlertKind; text: string }[] = [];
export let alertsSent = 0;

let cached: { at: number; w: Map<string, string[]> } | undefined;
/** Long-running mode: text alert to every chat watching any of `addrs` (watch lists re-read at most once a minute). Never throws. */
export async function alert(kind: AlertKind, text: string, addrs: string[]) {
  recentAlerts.unshift({ t: new Date().toISOString(), kind, text });
  recentAlerts.length = Math.min(recentAlerts.length, 50);
  log('info', 'alert', { kind, text });
  if (!cfg.telegramToken) return;
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), w: await loadWatchers() };
  for (const chat of watchersOf(cached.w, addrs)) {
    try { await tgCall(cfg.telegramToken, 'sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } }); alertsSent++; }
    catch (e) { log('warn', 'telegram send failed', { chat, err: String(e) }); }
  }
}

// ---------------------------------------------------------------- rich channel cards (hosted tick -> TELEGRAM_CHAT_ID)
export const APP = 'https://copas-mocha.vercel.app';
export type Btn = { text: string; url: string };
export type Card = { photo: string; caption: string; buttons: Btn[][] };
export type ChannelEvent = { eventName: string; address: string; args: Record<string, any>; transactionHash?: string | null };
/** Chain reads that turn an event into numbers: the Checkpoint in the same tx, the mandate, the follower's params, the previous roll. */
export type Extra = {
  checkpoint?: { unitPrice: bigint; peak: bigint; ddBps: bigint; leverageHdths: bigint };
  mandate?: { maxDDbps: number; maxLeverageHdths: number; epochLen?: bigint };
  follow?: { ratioBps: number; maxLeverageHdths: number; stopLossBps: number };
  prevUnit?: bigint; // EpochRolled: unit price when the epoch that just ended opened
};

export const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ausd = (x: unknown) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });
const unit = (x: bigint) => (Number(x) / 1e18).toFixed(6); // testnet drawdowns are basis points: 4 dp would hide them
const pctBps = (x: unknown) => `${(Number(x) / 100).toFixed(2)}%`;
const lev = (h: unknown) => `${(Number(h) / 100).toFixed(1)}x`;
const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const STATUS_NAME = ['Active', 'Unbonded', 'Breached'];

/** Addresses an event concerns: the leader book, plus the vault for follower events. Watchers of either get the card. */
export const eventAddrs = (ev: ChannelEvent) =>
  [(ev.eventName === 'LeaderCreated' ? String(ev.args?.leaderBook) : ev.address).toLowerCase(), ...(ev.args?.vault ? [String(ev.args.vault).toLowerCase()] : [])];

/** One photo card per Copas event (the leader's live OG image + real numbers + buttons), or null for events the channel ignores. */
export function channelCard(ev: ChannelEvent, x: Extra, explorer: string, app = APP, now = Date.now()): Card | null {
  const a = ev.args ?? {};
  const lb = (ev.eventName === 'LeaderCreated' ? String(a.leaderBook) : ev.address).toLowerCase();
  const L = `<a href="${app}/leader/${lb}">${shortA(lb)}</a>`;
  const tx = ev.transactionHash ? `\n<a href="${explorer}/tx/${ev.transactionHash}">View tx on explorer</a>` : '';
  const cp = x.checkpoint, m = x.mandate;
  let lines: string[];
  switch (ev.eventName) {
    case 'Breached': {
      const reason = BREACH_REASON[Number(a.reason)] ?? 'unknown';
      const cap = Number(a.capTotal);
      lines = [
        `<b>BREACH</b> · leader ${L} broke its <b>${esc(reason)}</b> mandate in epoch ${esc(a.epoch)}.`,
        cp ? `Unit price ${unit(cp.unitPrice)} vs epoch peak ${unit(cp.peak)}` : '',
        cp && m ? `Drawdown <b>${pctBps(cp.ddBps)}</b> vs mandate limit ${pctBps(m.maxDDbps)}` : '',
        cp && m && reason === 'leverage' ? `Leverage <b>${lev(cp.leverageHdths)}</b> vs limit ${lev(m.maxLeverageHdths)}` : '',
        `Bond slashed into the pot: <b>${ausd(a.pot)} AUSD</b>`,
        `Eligible follower capacity: ${ausd(cap)} AUSD${cap > 0 ? ` (pot covers ${((Number(a.pot) / cap) * 100).toFixed(1)}% of it)` : ' (no eligible followers)'}`,
        'Followers active this epoch can claim their share.',
      ];
      break;
    }
    case 'EpochRolled': {
      const e = Number(a.epoch);
      const u = BigInt(a.unitPrice);
      const p = x.prevUnit;
      lines = [
        `<b>Epoch ${e - 1} closed</b> · leader ${L}`,
        p ? `Unit price ${unit(p)} → ${unit(u)} (<b>${(((Number(u) - Number(p)) / Number(p)) * 100).toFixed(2)}%</b> this epoch)` : `Unit price at close: ${unit(u)}`,
        cp && cp.peak > 0n ? `Epoch high ${unit(cp.peak)}, closed ${pctBps(cp.ddBps)} below it` : '',
        `Epoch ${e} is open, status <b>${esc(STATUS_NAME[Number(a.status)] ?? a.status)}</b>`,
      ];
      break;
    }
    case 'FollowerRegistered': {
      const f = x.follow;
      lines = [
        `<b>New follower</b> · vault ${esc(shortA(String(a.vault)))} now copies leader ${L}`,
        f ? `Ratio ${f.ratioBps / 100}% of the leader's size · max leverage ${lev(f.maxLeverageHdths)} · stop-loss ${pctBps(f.stopLossBps)}` : '',
        `Cap ${ausd(a.cap)} AUSD (its weight in any slash payout), eligible from epoch ${esc(a.fromEpoch)}`,
      ];
      break;
    }
    case 'UnbondRequested':
      lines = [
        `<b>Unbond requested</b> · leader ${L} asked to withdraw <b>${ausd(a.amount)} AUSD</b> of its bond, unlocking at epoch ${esc(a.unlockEpoch)}.`,
        'Follower protection shrinks by that amount once it unlocks. Followers can tighten limits or unfollow before then.',
      ];
      break;
    case 'Claimed':
      lines = [`<b>Slash paid</b> · vault ${esc(shortA(String(a.vault)))} claimed <b>${ausd(a.amount)} AUSD</b> from the epoch ${esc(a.epoch)} pot of leader ${L}`];
      break;
    case 'LeaderCreated':
      lines = [
        `<b>New leader</b> ${L} (owner ${esc(shortA(String(a.owner)))}) registered on Copas`,
        m ? `Mandate: max drawdown ${pctBps(m.maxDDbps)} · max leverage ${lev(m.maxLeverageHdths)}${m.epochLen ? ` · ${Number(m.epochLen) / 3600}h epochs` : ''}` : '',
      ];
      break;
    default:
      return null;
  }
  const buttons: Btn[][] = [
    ...(ev.eventName === 'Breached' ? [[{ text: 'Claim', url: `${app}/me` }, { text: 'Proof', url: `${app}/proof` }]] : []),
    [{ text: 'Leader', url: `${app}/leader/${lb}` }, { text: 'Breach odds', url: `${app}/market/${lb}` }],
  ];
  return { photo: `${app}/leader/${lb}/opengraph-image?v=${now}`, caption: lines.filter(Boolean).join('\n') + tx, buttons };
}

async function tgCall(token: string, method: string, body: object) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

/**
 * Post a card to the alerts channel: sendPhoto with the OG image, or the same caption as text when Telegram can't fetch the image.
 * Returns the message, or null when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. Throws on a Telegram error (the tick retries).
 */
export async function sendChannelCard(card: Card, token = cfg.telegramToken, chatId = cfg.telegramChatId): Promise<{ message_id: number } | null> {
  if (!token || !chatId) return null;
  const common = { chat_id: chatId, parse_mode: 'HTML', reply_markup: { inline_keyboard: card.buttons } };
  // render the OG image once ourselves: a cold render can outlast Telegram's URL fetch, which then fails the photo
  await fetch(card.photo, { signal: AbortSignal.timeout(20_000) }).then((r) => r.arrayBuffer()).catch(() => undefined);
  try {
    return await tgCall(token, 'sendPhoto', { ...common, photo: card.photo, caption: card.caption });
  } catch (e) {
    log('warn', 'telegram sendPhoto failed, sending text', { err: String(e) });
    return tgCall(token, 'sendMessage', { ...common, text: card.caption, link_preview_options: { is_disabled: true } });
  }
}

// ponytail: last EpochRolled unit price per leader in DATA_DIR (the hosted run caches it); the first roll a keeper sees has no "before"
const UNITS = resolve(cfg.dataDir, 'epoch-units.json');
let units: Record<string, { epoch: string; unit: string }> = {};
try { units = JSON.parse(readFileSync(UNITS, 'utf8')); } catch { /* first run */ }

/** Reads the numbers a card needs. Never throws: a failed read just leaves that line out. */
export async function channelExtra(ev: ChannelEvent): Promise<Extra> {
  const x: Extra = {};
  const lb = (ev.eventName === 'LeaderCreated' ? String(ev.args.leaderBook) : ev.address) as Address;
  try {
    if ((ev.eventName === 'Breached' || ev.eventName === 'EpochRolled') && ev.transactionHash) {
      const rc = await client.getTransactionReceipt({ hash: ev.transactionHash as Hex });
      const cps = parseEventLogs({ abi: ABI.leader, eventName: 'Checkpoint', logs: rc.logs.filter((l) => l.address.toLowerCase() === lb.toLowerCase()) }) as any[];
      if (cps.length) x.checkpoint = cps.at(-1).args;
    }
    if (ev.eventName === 'Breached' || ev.eventName === 'LeaderCreated') x.mandate = (await client.readContract({ address: lb, abi: ABI.leader, functionName: 'mandate' })) as Extra['mandate'];
    if (ev.eventName === 'FollowerRegistered') x.follow = (await client.readContract({ address: ev.args.vault, abi: ABI.vault, functionName: 'params' })) as Extra['follow'];
  } catch (e) { log('warn', 'channel card read failed', { ev: ev.eventName, err: String(e) }); }
  if (ev.eventName === 'EpochRolled') {
    const k = lb.toLowerCase();
    const e = BigInt(ev.args.epoch);
    const prev = units[k];
    if (prev && BigInt(prev.epoch) === e - 1n) x.prevUnit = BigInt(prev.unit);
    units[k] = { epoch: String(e), unit: String(ev.args.unitPrice) };
    try { mkdirSync(cfg.dataDir, { recursive: true }); writeFileSync(UNITS, JSON.stringify(units)); } catch { /* read-only fs: no change line next roll */ }
  }
  return x;
}
