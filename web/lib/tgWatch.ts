import { del, get, put } from "@vercel/blob";

/**
 * Per-chat Telegram watch lists for @copas_monad_bot, one private Vercel Blob per chat (`tg/watch/<chatId>.json`).
 * The hosted keeper lists the same prefix each tick and DMs a chat when an event touches an address it watches.
 * One blob per chat, so two chats editing at once never overwrite each other.
 */
export const WATCH_PREFIX = "tg/watch/";
export const MAX_WATCH = 10;
const key = (chat: number | string) => `${WATCH_PREFIX}${chat}.json`;

export async function getWatch(chat: number | string): Promise<string[]> {
  const r = await get(key(chat), { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return [];
  const j = JSON.parse(await new Response(r.stream).text()) as { addrs?: string[] };
  return j.addrs ?? [];
}

export async function setWatch(chat: number | string, addrs: string[]) {
  if (!addrs.length) return void (await del(key(chat)));
  await put(key(chat), JSON.stringify({ addrs, at: new Date().toISOString() }), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}
