/**
 * A7 track-record attestation: a wallet's Perpl record, canonical JSON, keccak256, EIP-191 signature
 * by ATTESTER_PRIVATE_KEY. Verify: viem.verifyMessage({ address: attester, message: { raw: hash }, signature }).
 *
 * The windowed stats come from getLeaderData, i.e. the exact fills, window and source /leader/:addr/analysis
 * uses, so the two never disagree. Other sources are kept in their own, labelled fields.
 */
import { type Hex, keccak256, toBytes, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type LeaderData, PLUMB_API, getLeaderData } from "./leaderData.js";
import { type Fetch, canonicalJson, requireEnv } from "./util.js";

export interface TrackRecord {
  schema: "copas.trackrecord.v2";
  address: string;
  chainId: number; // 143 mainnet, 10143 testnet (Copas LeaderBooks)
  venue: "perpl";
  asOf: number; // unix s
  window: { from: number; to: number }; // span the fill stats below cover
  complete: boolean; // false: the fill history was capped and `window` shrunk to what was fetched
  fillsUsed: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  pnl30d: string; // AUSD; source in pnl30dSource
  pnl30dSource: "fills" | "perpl-leaderboard"; // leaderboard only when the fills are capped and it exists
  winRateBps: number; // closed round trips in `window`
  closedTrades: number;
  maxDrawdown: string; // AUSD on the realized curve in `window`
  maxDrawdownPct: number | null; // of the Perpl ROI capital base
  perplLeaderboard30d: { pnl: string; roiBps: number; volume: string } | null; // official, mainnet only
  allTime: { netPnl: string; closedTrades: number; winRateBps: number; maxDrawdown: string; firstSeenAt: number; lastSeenAt: number } | null; // Envio Account aggregates
  sources: string[];
}
export interface Attestation {
  record: TrackRecord;
  canonical: string;
  hash: Hex;
  signature: Hex;
  attester: `0x${string}`;
  label: "offchain attested";
}

const s6 = (x: number) => x.toFixed(6);
const bps = (x: number) => Math.round(x * 10_000);

export function buildTrackRecord(d: LeaderData): TrackRecord {
  const st = d.stats;
  const row = d.official30d;
  const useBoard = !d.complete && !!row;
  const a = d.envioAccount;
  return {
    schema: "copas.trackrecord.v2",
    address: d.address,
    chainId: d.chainId,
    venue: "perpl",
    asOf: d.window.to,
    window: d.window,
    complete: d.complete,
    fillsUsed: d.fills.length,
    firstTradeAt: d.fills[0]?.ts ?? null,
    lastTradeAt: st.lastTradeAt,
    pnl30d: s6(useBoard ? row!.pnl : st.netPnl),
    pnl30dSource: useBoard ? "perpl-leaderboard" : "fills",
    winRateBps: bps(st.winRate),
    closedTrades: st.closedTrades,
    maxDrawdown: s6(st.maxDrawdown),
    maxDrawdownPct: d.capitalEstimate ? Math.round((st.maxDrawdown / d.capitalEstimate) * 10_000) / 100 : null,
    perplLeaderboard30d: row ? { pnl: s6(row.pnl), roiBps: bps(row.roi), volume: s6(row.volume) } : null,
    allTime: a
      ? { netPnl: s6(Number(a.netPnlCNS) / 1e6), closedTrades: a.closedTrades, winRateBps: a.closedTrades ? bps(a.wins / a.closedTrades) : 0, maxDrawdown: s6(Number(a.maxDrawdownCNS) / 1e6), firstSeenAt: a.firstSeenAt, lastSeenAt: a.lastSeenAt }
      : null,
    sources: [
      d.source === "envio" ? "envio:copas-indexer Fill" : `${PLUMB_API}/wallets/:addr/trades`,
      ...(row ? ["https://app.perpl.xyz/api/v1/trading/leaderboard/month/pnl"] : []),
      ...(a ? ["envio:copas-indexer Account"] : []),
    ],
  };
}

export async function signTrackRecord(record: TrackRecord): Promise<Attestation> {
  const account = privateKeyToAccount(requireEnv("ATTESTER_PRIVATE_KEY") as Hex);
  const canonical = canonicalJson(record);
  const hash = keccak256(toBytes(canonical));
  const signature = await account.signMessage({ message: { raw: hash } });
  return { record, canonical, hash, signature, attester: account.address, label: "offchain attested" };
}

export async function verifyAttestation(a: Pick<Attestation, "record" | "hash" | "signature" | "attester">): Promise<boolean> {
  if (keccak256(toBytes(canonicalJson(a.record))) !== a.hash) return false;
  return verifyMessage({ address: a.attester, message: { raw: a.hash }, signature: a.signature });
}

export async function attest(address: string, opts: { fetch?: Fetch; now?: number; days?: number } = {}): Promise<Attestation> {
  requireEnv("ATTESTER_PRIVATE_KEY"); // fail fast before any fetch
  return signTrackRecord(buildTrackRecord(await getLeaderData(address, { days: opts.days ?? 30, now: opts.now, fetch: opts.fetch })));
}
