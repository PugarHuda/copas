import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { createPublicClient, http, type Abi } from "viem";
import { breachInputs, getDownMarket, getLeaders as readLeaders } from "@/lib/copas/data";
import { WEEK, copasBreaches, seasonBoard, weekStart } from "@/lib/copas/indexer";
import { breachMath } from "@/lib/copas/math";
import { copasAbi, deployment, type Leader } from "@/lib/copas/contracts";
import { copasChain, explorerTx } from "@/lib/chains";
import { getLeaderboard, type LbPeriod } from "@/lib/perpl/api";
import { num, pct, pctAuto, short } from "@/lib/format";

/**
 * @copas_monad_bot webhook (setWebhook url=…/api/telegram, secret_token=TELEGRAM_WEBHOOK_SECRET).
 * Stateless: every answer is a live chain / indexer / Perpl read. Leader cards carry a ↻ button that re-reads the
 * LeaderBook and edits the card (image + numbers) in place, in chats, groups and inline-shared messages alike.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const APP = "https://copas-mocha.vercel.app";
type Btn = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
type Chat = { id: number; type: string };
type Msg = { message_id: number; chat: Chat; text?: string; photo?: unknown[] };
type Update = {
  message?: Msg;
  callback_query?: { id: string; data?: string; message?: Msg; inline_message_id?: string };
  inline_query?: { id: string; query: string };
};

// Bot API responses of this update, returned to the caller (Telegram ignores a body without `method`); per request, instances are shared
const sent = new AsyncLocalStorage<unknown[]>();
async function tg(method: string, body: object) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))) as { ok: boolean; description?: string };
  sent.getStore()?.push({ method, ok: j.ok, ...(j.ok ? { result: pickIds((j as { result?: unknown }).result) } : { description: j.description }) });
  return j;
}
const followers = (n: number | null) => (n == null ? "– followers" : `${n} follower${n === 1 ? "" : "s"}`);
const pickIds = (r: unknown) => (r && typeof r === "object" && "message_id" in r ? { message_id: (r as { message_id: number }).message_id } : r);

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ausd = (v: number) => `${num(v, Math.abs(v) < 1 && v !== 0 ? 4 : 2)} AUSD`;
const og = (book: string) => `${APP}/leader/${book.toLowerCase()}/opengraph-image?v=${Date.now()}`;
const utc = () => new Date(readAt || Date.now()).toISOString().slice(11, 19);
/** Mini App button in private chats; Telegram rejects web_app buttons in groups and inline messages, so a plain link there. */
const open = (text: string, url: string, priv: boolean): Btn => (priv ? { text, web_app: { url } } : { text, url });

/**
 * The registry read fans out into many RPC calls and the public testnet RPC drops some under load. Reads go through Next's shared
 * data cache (15 s, failures never cached, a failed revalidation keeps serving the last good read), then retry. `readAt` is printed
 * on cards so a cached read never poses as a live one.
 */
const cachedLeaders = unstable_cache(
  async () => {
    const ls = await readLeaders();
    if (!ls) throw new Error("registry read failed");
    return { at: Date.now(), ls };
  },
  ["tg-leaders"],
  { revalidate: 15 },
);
let readAt = 0;
async function getLeaders() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await cachedLeaders();
      readAt = r.at;
      return r.ls;
    } catch {
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
    }
  }
  return null;
}

/** Active first, then bigger bond: the order /leaders shows and #n refers to. */
const ranked = (ls: Leader[]) => [...ls].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.bond - a.bond);
function find(ls: Leader[], arg = "") {
  const q = arg.trim().toLowerCase();
  if (!q) return null;
  const r = ranked(ls);
  if (/^#\d+$/.test(q)) return r[Number(q.slice(1)) - 1] ?? null;
  return r.find((l) => (q.startsWith("0x") && q.length >= 4 ? l.book.toLowerCase().startsWith(q) : l.name.toLowerCase().includes(q))) ?? null;
}

/** 10-cell drawdown radar: how much of the mandate the leader has used this epoch. */
function radar(l: Leader) {
  const used = l.maxDD > 0 ? Math.min(1, l.liveDD / l.maxDD) : 0;
  const n = Math.round(used * 10);
  return `[${"■".repeat(n)}${"□".repeat(10 - n)}] ${num(used * 100, 0)}% of mandate used`;
}

function caption(l: Leader) {
  const left = l.epochEnd - Date.now();
  return [
    `<b>${esc(l.name)}</b> · ${l.status.toUpperCase()}`,
    `Bond <b>${ausd(l.bond)}</b>${l.underwritten ? ` + ${ausd(l.underwritten)} underwritten` : ""} · capacity ${ausd(l.capacity)}`,
    `Live drawdown <b>${pctAuto(l.liveDD)}</b> vs limit ${pctAuto(l.maxDD)}`,
    radar(l),
    `Unit price ${l.unitPrice.toFixed(6)} (epoch peak ${l.peakUnitPrice.toFixed(6)}) · since start ${pct(l.returnTotal, 2, true)}`,
    `Epoch ${l.epoch}${left > 0 ? ` · ends in ${Math.floor(left / 3_600_000)}h ${Math.floor((left % 3_600_000) / 60_000)}m` : " · ready to roll"}`,
    `${followers(l.followers)} · copied capital ${ausd(l.followerAum)} · max leverage ${num(l.maxLeverage, 1)}x · fee ${num(l.feePct, 0)}%`,
    `<i>${Date.now() - readAt > 60_000 ? "last good read" : "read"} ${utc()} UTC</i>`,
  ].join("\n");
}

function cardKeyboard(l: Leader, priv: boolean): Btn[][] {
  const b = l.book.toLowerCase();
  return [
    [{ text: "↻ Refresh", callback_data: `R:${b}` }, open("Open in Copas", `${APP}/leader/${b}`, priv)],
    [{ text: "Breach odds", url: `${APP}/market/${b}` }, { text: "Follow", url: `${APP}/follow/${b}` }, { text: "Proof", url: `${APP}/proof` }],
  ];
}

async function sendCard(chat: Chat, l: Leader) {
  const kb = { inline_keyboard: cardKeyboard(l, chat.type === "private") };
  const r = await tg("sendPhoto", { chat_id: chat.id, photo: og(l.book), caption: caption(l), parse_mode: "HTML", reply_markup: kb });
  if (!r.ok) await tg("sendMessage", { chat_id: chat.id, text: caption(l), parse_mode: "HTML", reply_markup: kb });
}

const say = (chat: Chat, text: string, keyboard?: Btn[][]) =>
  tg("sendMessage", { chat_id: chat.id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });

const HELP = [
  "<b>Copas</b>: copy traders who post a bond. Break the mandate and the bond pays the followers.",
  "",
  "/leaders: bonded leaders ranked, with live drawdown",
  "/leader &lt;0xaddr | #n | name&gt;: live leader card with a ↻ button that updates it in place",
  "/odds &lt;leader&gt;: the Kuru market's odds this leader breaks the mandate",
  "/proof: the latest real breach with its drawdown math",
  "/reality [week|month|all]: how many Perpl traders lost money",
  "/season: this week's follower-outcome league",
  "",
  "Share a leader in any chat: type <code>@copas_monad_bot 0xb1b0</code> or <code>@copas_monad_bot leaders</code>.",
].join("\n");

const NO_CHAIN = "Couldn't read the Copas registry on Monad testnet right now. Try again in a minute.";

async function command(chat: Chat, text: string) {
  const [raw, ...rest] = text.trim().split(/\s+/);
  const cmd = raw.replace(/@\w+$/, "").toLowerCase();
  const arg = rest.join(" ");
  const priv = chat.type === "private";
  switch (cmd) {
    case "/start":
      return say(chat, HELP, [[open("Open Copas", APP, priv)], [{ text: "Leaders", callback_data: "LS" }, { text: "Latest breach", callback_data: "PF" }]]);
    case "/help":
      return say(chat, HELP);
    case "/leaders":
      return leaders(chat);
    case "/leader": {
      const ls = await getLeaders();
      if (!ls) return say(chat, NO_CHAIN);
      const l = find(ls, arg);
      return l ? sendCard(chat, l) : say(chat, `No Copas leader matches <code>${esc(arg || "(empty)")}</code>. Try /leaders, then /leader #1.`);
    }
    case "/odds":
      return odds(chat, arg);
    case "/proof":
      return proof(chat);
    case "/reality":
      return reality(chat, arg);
    case "/season":
      return season(chat);
    default:
      return priv ? say(chat, HELP) : undefined; // groups: stay quiet on commands meant for other bots
  }
}

async function leaders(chat: Chat) {
  const ls = await getLeaders();
  if (!ls) return say(chat, NO_CHAIN);
  if (!ls.length) return say(chat, "No leaders registered yet.");
  const r = ranked(ls).slice(0, 10);
  const lines = r.map(
    (l, i) =>
      `<b>#${i + 1} ${esc(l.name)}</b> · ${l.status.toUpperCase()}\n   bond ${ausd(l.bond)} · drawdown ${pctAuto(l.liveDD)} / ${pctAuto(l.maxDD)} · ${followers(l.followers)}`,
  );
  const kb = r.map((l, i) => [{ text: `#${i + 1} ${l.name} card`, callback_data: `L:${l.book.toLowerCase()}` }]);
  return say(chat, `<b>Bonded leaders</b> (live, Monad testnet)\n\n${lines.join("\n")}`, kb);
}

async function odds(chat: Chat, arg: string) {
  const ls = await getLeaders();
  if (!ls) return say(chat, NO_CHAIN);
  const l = find(ls, arg);
  if (!l) return say(chat, "Usage: /odds &lt;0xaddr | #n | name&gt;. See /leaders.");
  const m = await getDownMarket(l.book, l.epoch).catch(() => null);
  const kb = [[{ text: "Breach odds market", url: `${APP}/market/${l.book.toLowerCase()}` }]];
  if (!m) return say(chat, `<b>${esc(l.name)}</b> · epoch ${l.epoch}\nNo UP/DOWN series minted for this or the next epoch yet, so the market has no odds. Mint the first pair on the market page.`, kb);
  const px = m.bid && m.ask ? (m.bid + m.ask) / 2 : m.ask || m.bid; // same price rule as /market
  return say(
    chat,
    [
      `<b>${esc(l.name)}</b> · DOWN, epoch ${m.epoch}${m.settled ? ` (settled: ${m.breach ? "breached" : "held"})` : ""}`,
      px
        ? `The market's odds this leader breaks the mandate: <b>${pct(px * 100, 0)}</b>`
        : "No DOWN orders on Kuru yet, so no odds. DOWN pays 1 AUSD if the leader breaches this epoch.",
      `Kuru best bid ${m.bid ? num(m.bid, 2) : "–"} · best ask ${m.ask ? num(m.ask, 2) : "–"} · ${num(m.supply, 2)} DOWN minted`,
      `Live drawdown now ${pctAuto(l.liveDD)} vs limit ${pctAuto(l.maxDD)}`,
    ].join("\n"),
    kb,
  );
}

async function proof(chat: Chat) {
  const [live, ls] = await Promise.all([copasBreaches(), getLeaders()]);
  const target = live?.[0] ?? ls?.filter((l) => l.status === "breached").map((l) => ({ book: l.book, epoch: l.epoch, claims: [], tx: undefined as string | undefined }))[0];
  const b = target ? await breachInputs(target.book as `0x${string}`, target.epoch, target.claims[0]) : null;
  if (!target || !b) return say(chat, "No breach to show yet (or the chain read failed).");
  const m = breachMath(b);
  const name = ls?.find((l) => l.book.toLowerCase() === b.book.toLowerCase())?.name ?? short(b.book);
  return say(
    chat,
    [
      `<b>Latest breach</b> · ${esc(name)} · epoch ${b.epoch} · block ${b.block}`,
      "",
      `<code>unit  = equity / units = ${num(b.equity, 6)} / ${num(b.units, 6)} = ${m.unit.toFixed(6)}</code>`,
      `<code>dd    = 1 − unit / peak = 1 − ${m.unit.toFixed(6)} / ${b.peak.toFixed(6)} = ${m.dd.toFixed(4)}%</code>`,
      `<code>${m.dd.toFixed(4)}% ${m.breach ? ">" : "≤"} mandate ${b.maxDD}% → ${m.breach ? "BREACH" : "no breach"}</code>`,
      `<code>claim = min(slash × cap / capTotal, loss)</code>`,
      `<code>      = min(${num(b.slash, 2)} × ${num(b.cap, 2)} / ${num(b.capTotal, 2)}, ${num(b.loss, 6)}) = ${num(m.claim, 6)} AUSD</code>`,
      "",
      "Inputs: the breaching Checkpoint log, breachOf(epoch) and the mandate, read from the LeaderBook just now.",
      target.tx ? `<a href="${explorerTx(target.tx, copasChain.id)}">Breach tx on explorer</a>` : "",
    ].join("\n"),
    [[{ text: "Recompute it yourself", url: `${APP}/proof` }]],
  );
}

const PERIODS: Record<string, { k: LbPeriod; label: string }> = { week: { k: "week", label: "7 days" }, month: { k: "month", label: "30 days" }, all: { k: "all", label: "all time" } };

async function reality(chat: Chat, arg: string) {
  const p = PERIODS[arg.trim().toLowerCase()] ?? PERIODS.month;
  const client = createPublicClient({ chain: copasChain, transport: http() });
  const [rows, bondBps] = await Promise.all([
    getLeaderboard(p.k, "pnl").catch(() => null),
    deployment?.registry ? client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "bondRatioBps" }).then(Number).catch(() => null) : null,
  ]);
  if (!rows) return say(chat, "Perpl leaderboard unreachable right now. Try again in a minute.");
  // same math as /saved
  const active = rows.filter((r) => r.pnl !== 0);
  const losers = active.filter((r) => r.pnl < 0);
  const lost = -losers.reduce((a, r) => a + r.pnl, 0);
  const won = active.filter((r) => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
  const worst = [...losers].sort((a, b) => a.pnl - b.pnl).slice(0, 3);
  const share = active.length ? (losers.length / active.length) * 100 : 0;
  return say(
    chat,
    [
      `<b>Reality check</b> · Perpl leaderboard, ${p.label}`,
      `<b>${num(share, 0)}%</b> of traders lost money (${losers.length} of ${active.length} with non-zero PnL)`,
      `Lost by losers: <b>$${num(lost, 0)}</b> · won by winners: $${num(won, 0)}`,
      "",
      "Biggest losers (copy them and you eat this, no recourse):",
      ...worst.map((r, i) => `${i + 1}. <code>${short(r.address)}</code> −$${num(-r.pnl, 0)}`),
      "",
      `On Copas a leader bonds ${bondBps != null ? `${num(bondBps / 100, 0)}%` : "a share"} of follower capacity, and breaking the mandate slashes it to the followers.`,
    ].join("\n"),
    [[{ text: "Would Copas have saved you?", url: `${APP}/saved?p=${p.k}` }]],
  );
}

async function season(chat: Chat) {
  const now = Math.floor(Date.now() / 1000);
  const from = weekStart(now);
  const [board, ls] = await Promise.all([seasonBoard(from, from + WEEK), getLeaders()]);
  if (!board) return say(chat, "The Copas indexer did not respond, so this season can't be computed. Try again shortly.");
  const names = new Map((ls ?? []).map((l) => [l.book.toLowerCase(), l.name]));
  const rows = board.rows.sort((a, b) => b.net - a.net || b.bond - a.bond).slice(0, 8);
  const n = Math.round((from - weekStart(board.firstAt)) / WEEK) + 1;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const money = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${num(Math.abs(v), Math.abs(v) < 1 && v !== 0 ? 4 : 2)}`;
  return say(
    chat,
    [
      `<b>${n < 1 ? "Pre-season" : `Season ${n}`}</b> · ${day(from)} – ${day(from + WEEK - 86_400)}`,
      "Ranked by what followers took home (trade PnL − fees + slash paid − performance fees), not leader PnL.",
      "",
      ...(rows.length
        ? rows.map((r, i) => `${i + 1}. <b>${esc(names.get(r.book) ?? short(r.book))}</b> ${money(r.net)} · ${followers(r.followers)} · ${r.fills} fills${r.breaches ? ` · ${r.breaches} breach` : ""}${r.slashPaid ? ` · slash paid ${money(r.slashPaid)}` : ""}`)
        : ["No leader activity this week yet."]),
    ].join("\n"),
    [[{ text: "Full season table", url: `${APP}/seasons` }]],
  );
}

async function callback(cq: NonNullable<Update["callback_query"]>) {
  const [kind, addr] = (cq.data ?? "").split(":");
  const chat = cq.message?.chat;
  if (kind === "LS" && chat) await leaders(chat);
  else if (kind === "PF" && chat) await proof(chat);
  else if (kind === "L" || kind === "R") {
    const ls = await getLeaders();
    const l = ls?.find((x) => x.book.toLowerCase() === addr);
    if (!l) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Couldn't read this leader right now.", show_alert: true });
    if (kind === "L" && chat) await sendCard(chat, l);
    if (kind === "R") {
      // edit in place: photo cards swap image + caption, text cards (inline shares) swap text + preview image
      const priv = chat?.type === "private";
      const where = cq.inline_message_id ? { inline_message_id: cq.inline_message_id } : { chat_id: chat!.id, message_id: cq.message!.message_id };
      const reply_markup = { inline_keyboard: cardKeyboard(l, priv) };
      if (cq.message?.photo) await tg("editMessageMedia", { ...where, media: { type: "photo", media: og(l.book), caption: caption(l), parse_mode: "HTML" }, reply_markup });
      else await tg("editMessageText", { ...where, text: caption(l), parse_mode: "HTML", link_preview_options: { url: og(l.book), prefer_large_media: true, show_above_text: true }, reply_markup });
      return tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Live: drawdown ${pctAuto(l.liveDD)} of ${pctAuto(l.maxDD)}` });
    }
  }
  return tg("answerCallbackQuery", { callback_query_id: cq.id });
}

/** Inline mode: `@copas_monad_bot <0xaddr | name | leaders>` in any chat returns shareable live leader cards. */
async function inline(iq: NonNullable<Update["inline_query"]>) {
  const ls = (await getLeaders()) ?? [];
  const q = iq.query.trim().toLowerCase();
  const hits = !q || q === "leaders" ? ranked(ls) : ranked(ls).filter((l) => (q.startsWith("0x") ? l.book.toLowerCase().startsWith(q) : l.name.toLowerCase().includes(q)));
  const results = hits.slice(0, 20).map((l) => ({
    type: "article",
    id: l.book.toLowerCase(),
    title: `${l.name} · ${l.status.toUpperCase()}`,
    description: `Bond ${ausd(l.bond)} · drawdown ${pctAuto(l.liveDD)} / ${pctAuto(l.maxDD)} · ${followers(l.followers)}`,
    thumbnail_url: og(l.book),
    input_message_content: { message_text: caption(l), parse_mode: "HTML", link_preview_options: { url: og(l.book), prefer_large_media: true, show_above_text: true } },
    reply_markup: { inline_keyboard: cardKeyboard(l, false) },
  }));
  return tg("answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 30, button: { text: "Open Copas", web_app: { url: APP } } });
}

function authorized(req: Request) {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (!want || !got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorized(req) || !process.env.TELEGRAM_BOT_TOKEN) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = (await req.json().catch(() => null)) as Update | null;
  const out: unknown[] = [];
  await sent.run(out, async () => {
    try {
      if (u?.message?.text?.startsWith("/")) await command(u.message.chat, u.message.text);
      else if (u?.message?.text && u.message.chat.type === "private") await say(u.message.chat, HELP);
      else if (u?.callback_query) await callback(u.callback_query);
      else if (u?.inline_query) await inline(u.inline_query);
    } catch (e) {
      out.push({ error: String(e) });
    }
  });
  // always 200 once authenticated: a non-2xx makes Telegram redeliver the same update
  return NextResponse.json({ ok: true, sent: out });
}
