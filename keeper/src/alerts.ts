// G4 alerts: Telegram bot with a tiny JSON subscriber store.
// /start = all alerts · /watch <leaderBook|vault> = only those addresses · /unwatch <addr> · /stop · /list
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEventLogs, type Address, type Hex } from 'viem';
import { ABI, cfg, log } from './config.js';
import { client } from './chain.js';
import { BREACH_REASON } from './logic.js';

export type AlertKind = 'position-opened' | 'position-closed' | 'dd-warning' | 'breach' | 'claim-available' | 'unbond-requested' | 'stop-loss';

const FILE = resolve(cfg.dataDir, 'subscribers.json');
const API = `https://api.telegram.org/bot${cfg.telegramToken}`;
let subs: Record<string, string[]> = {}; // chatId -> watched addresses (empty = everything)
try { subs = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* first run */ }
const save = () => { mkdirSync(cfg.dataDir, { recursive: true }); writeFileSync(FILE, JSON.stringify(subs, null, 2)); };

export const recentAlerts: { t: string; kind: AlertKind; text: string }[] = [];
export let alertsSent = 0;

async function tg(method: string, body: object) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}

/** Fan an alert out to every chat watching any of `addrs` (or everything). Never throws. */
export async function alert(kind: AlertKind, text: string, addrs: string[]) {
  recentAlerts.unshift({ t: new Date().toISOString(), kind, text });
  recentAlerts.length = Math.min(recentAlerts.length, 50);
  log('info', 'alert', { kind, text });
  if (!cfg.telegramToken) return;
  const want = addrs.map((a) => a.toLowerCase());
  for (const [chat, watch] of Object.entries(subs)) {
    if (watch.length && !watch.some((w) => want.includes(w))) continue;
    try { await tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true }); alertsSent++; }
    catch (e) { log('warn', 'telegram send failed', { chat, err: String(e) }); }
  }
}

function command(chat: string, text: string): string {
  const [cmd, arg] = text.trim().split(/\s+/);
  const addr = arg?.toLowerCase();
  switch (cmd.replace(/@.*/, '')) {
    case '/start': subs[chat] ??= []; save(); return 'Subscribed to Copas alerts. /watch <address> to narrow to a leader or vault, /stop to leave.';
    case '/watch':
      if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) return 'Usage: /watch 0x<leaderBook or vault>';
      subs[chat] = [...new Set([...(subs[chat] ?? []), addr])]; save(); return `Watching ${addr}`;
    case '/unwatch': subs[chat] = (subs[chat] ?? []).filter((a) => a !== addr); save(); return `Stopped watching ${addr}`;
    case '/stop': delete subs[chat]; save(); return 'Unsubscribed.';
    case '/list': return subs[chat] ? (subs[chat].length ? subs[chat].join('\n') : 'All alerts') : 'Not subscribed. /start';
    default: return 'Commands: /start /watch <addr> /unwatch <addr> /list /stop';
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

/** Long-polls getUpdates for subscription commands. */
export async function runTelegramBot() {
  if (!cfg.telegramToken) return log('info', 'telegram disabled (no TELEGRAM_BOT_TOKEN)');
  let offset = 0;
  for (;;) {
    try {
      const updates: any[] = await tg('getUpdates', { offset, timeout: 30 });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (m?.text?.startsWith('/')) await tg('sendMessage', { chat_id: m.chat.id, text: command(String(m.chat.id), m.text) });
      }
    } catch (e) {
      log('warn', 'telegram poll failed', { err: String(e) });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
