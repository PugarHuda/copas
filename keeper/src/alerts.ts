// G4 alerts: Telegram bot with a tiny JSON subscriber store.
// /start = all alerts · /watch <leaderBook|vault> = only those addresses · /unwatch <addr> · /stop · /list
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg, log } from './config.js';

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

/**
 * Post to the public alerts channel (TELEGRAM_CHAT_ID, e.g. @copas_alerts or -100…). Used by the hosted tick, which has no
 * long-running bot to collect /start subscribers. Returns false when the env is not set. Throws on a Telegram error.
 */
export async function sendChannel(text: string, token = cfg.telegramToken, chatId = cfg.telegramChatId): Promise<boolean> {
  if (!token || !chatId) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram sendMessage: ${j.description ?? r.status}`);
  return true;
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
