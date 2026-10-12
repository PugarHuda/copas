// Kuru V1 DOWN/AUSD book: L2 depth (OrderBook.getL2Book), recent fills (Trade logs via Envio HyperSync), and the
// market-order math the trade panel uses. Book params are the DOWN_MARKET_DEFAULTS the keeper lists with
// (onramp/src/kuru/market.ts): price precision 1e4, size precision 1e2, taker fee 30 bps, both tokens 6 decimals.
import { decodeAbiParameters, parseAbi, type Hex, type PublicClient } from "viem";

export const KURU = { pricePrecision: 10_000, sizePrecision: 100, takerFeeBps: 30 } as const;

export const kuruBookAbi = parseAbi([
  "function getL2Book() view returns (bytes)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
]);

export type Level = { price: number; size: number }; // AUSD per DOWN, DOWN
export type Depth = { block: number; bids: Level[]; asks: Level[] };

/** getL2Book layout: 32-byte block number, then (price, size) words for bids until a zero word, then asks. */
export function decodeL2(hex: Hex): Depth {
  const w = (i: number) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  const n = (hex.length - 2) / 64;
  const bids: Level[] = [], asks: Level[] = [];
  let side = bids;
  for (let i = 1; i < n; ) {
    const p = w(i++);
    if (p === 0n) { side = asks; continue; }
    side.push({ price: Number(p) / KURU.pricePrecision, size: Number(w(i++)) / KURU.sizePrecision });
  }
  return { block: Number(w(0)), bids, asks };
}

export async function readDepth(client: PublicClient, market: `0x${string}`): Promise<Depth> {
  return decodeL2((await client.readContract({ address: market, abi: kuruBookAbi, functionName: "getL2Book" })) as Hex);
}

/**
 * Walks the book for an IOC market order. buy: `amount` AUSD in, DOWN out. sell: `amount` DOWN in, AUSD out.
 * Taker fee comes off the output. `filled` < amount means the book is too thin for the whole order.
 */
export function walkBook(d: Depth, side: "buy" | "sell", amount: number) {
  let left = amount, out = 0;
  for (const l of side === "buy" ? d.asks : d.bids) {
    if (left <= 0) break;
    if (side === "buy") {
      const spend = Math.min(left, l.price * l.size);
      out += spend / l.price;
      left -= spend;
    } else {
      const take = Math.min(left, l.size);
      out += take * l.price;
      left -= take;
    }
  }
  out *= 1 - KURU.takerFeeBps / 1e4;
  return { out, filled: amount - Math.max(0, left), avgPrice: side === "buy" ? (amount - left) / (out || 1) : out / ((amount - left) || 1) };
}

export type KuruFill = { tx: string; block: number; ts: number; price: number; size: number; takerSide: "buy" | "sell"; maker: string; taker: string };

/**
 * Recent fills on a Kuru book from Envio HyperSync (the public Monad testnet RPC caps eth_getLogs at 100 blocks).
 * Trade(uint40 orderId, address maker, bool isBuy, uint256 price, uint96 updatedSize, address taker, address txOrigin, uint96 filledSize);
 * isBuy is the taker's side (checked on testnet: a market buy logs true), price is 1e18-scaled, filledSize is in size precision.
 */
const TRADE_TOPIC = "0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581";
const tradeParams = [
  { type: "uint40" }, { type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint96" }, { type: "address" }, { type: "address" }, { type: "uint96" },
] as const;

export async function readFills(market: `0x${string}`, chainId: number, limit = 20): Promise<KuruFill[] | null> {
  const token = process.env.ENVIO_API_TOKEN;
  if (!token || chainId !== 10143) return null;
  const r = await fetch("https://monad-testnet.hypersync.xyz/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      from_block: 69_000_000, // before the first DOWN book was listed (testnet deploy, 11 Oct 2026)
      logs: [{ address: [market], topics: [[TRADE_TOPIC]] }],
      field_selection: { log: ["block_number", "transaction_hash", "data"], block: ["number", "timestamp"] },
    }),
    next: { revalidate: 30 },
  });
  if (!r.ok) throw new Error(`hypersync ${r.status}`);
  const j = (await r.json()) as { data: { logs: { block_number: number; transaction_hash: string; data: Hex }[]; blocks: { number: number; timestamp: string }[] }[] };
  const ts = new Map<number, number>();
  const logs = j.data.flatMap((d) => (d.blocks.forEach((b) => ts.set(b.number, Number(b.timestamp))), d.logs));
  return logs
    .map((l) => {
      const [, maker, isBuy, price, , taker, , filled] = decodeAbiParameters(tradeParams, l.data);
      return { tx: l.transaction_hash, block: l.block_number, ts: ts.get(l.block_number) ?? 0, price: Number(price) / 1e18, size: Number(filled) / KURU.sizePrecision, takerSide: isBuy ? "buy" : "sell", maker, taker } as KuruFill;
    })
    .sort((a, b) => b.block - a.block)
    .slice(0, limit);
}
