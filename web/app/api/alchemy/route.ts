import { NextResponse } from "next/server";
import { allWatches } from "@/lib/tgWatch";
import { copasChain, explorerTx } from "@/lib/chains";
import { short } from "@/lib/format";
import { verifyAlchemy as verify } from "@/lib/alchemy";

/**
 * Alchemy Notify (Address Activity) receiver: the low-latency path for token flows on watched Copas addresses
 * (vault deposits and withdrawals, bonds posted, slash payouts). The keeper's 5-minute tick covers every other event.
 * Signature: `x-alchemy-signature` = hex HMAC-SHA256(raw body, ALCHEMY_WEBHOOK_SIGNING_KEY). Set up: keeper/README.md.
 */
export const dynamic = "force-dynamic";

const esc = (v: unknown) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isHex = (v: unknown, n: number) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);

type Activity = { fromAddress?: string; toAddress?: string; hash?: string; value?: number | null; asset?: string | null; category?: string };
type Payload = { type?: string; event?: { network?: string; activity?: Activity[] } };

export async function POST(req: Request) {
  const key = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  if (!key) return NextResponse.json({ error: "ALCHEMY_WEBHOOK_SIGNING_KEY not set" }, { status: 503 });
  const body = await req.text();
  if (!verify(body, req.headers.get("x-alchemy-signature"), key)) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  const p = JSON.parse(body) as Payload;
  const acts = p.type === "ADDRESS_ACTIVITY" ? (p.event?.activity ?? []) : [];
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!acts.length || !token) return NextResponse.json({ ok: true, sent: 0 });

  const watches = await allWatches();
  let sent = 0;
  for (const a of acts) {
    const touched = [a.fromAddress, a.toAddress].filter((x) => isHex(x, 40)).map((x) => x!.toLowerCase());
    const chats = [...watches].filter(([, w]) => w.some((x) => touched.includes(x))).map(([c]) => c);
    if (!chats.length) continue;
    // signed by Alchemy, but still outside data: every value is escaped (HTML parse mode) or validated before it is shown
    const asset = typeof a.asset === "string" && /^[A-Za-z0-9.]{1,16}$/.test(a.asset) ? a.asset : "";
    const amount = typeof a.value === "number" && Number.isFinite(a.value) ? `${a.value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${asset}`.trim() : asset || "a transfer";
    const text = [
      `<b>Transfer on a watched address</b> (Alchemy Notify, ${esc(p.event?.network ?? "Monad")})`,
      `${esc(amount)}: <code>${isHex(a.fromAddress, 40) ? short(a.fromAddress!) : "?"}</code> → <code>${isHex(a.toAddress, 40) ? short(a.toAddress!) : "?"}</code>`,
      isHex(a.hash, 64) ? `<a href="${explorerTx(a.hash!, copasChain.id)}">View tx on explorer</a>` : "",
    ].filter(Boolean).join("\n");
    for (const chat_id of chats) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (r?.ok) sent++;
    }
  }
  // 200 even if a DM failed: a non-2xx makes Alchemy retry the whole batch
  return NextResponse.json({ ok: true, sent });
}
