/**
 * A7 track-record attestation: a wallet's pre-Copas Perpl record, canonical JSON, keccak256, EIP-191 signature
 * by ATTESTER_PRIVATE_KEY. Verify: viem.verifyMessage({ address: attester, message: { raw: hash }, signature }).
 */
import { type Hex, keccak256, toBytes, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Fill, closedTrades, computeStats, fetchLeaderboard, fetchPlumbFills, fetchEnvioFills, maxDrawdown, equityCurve, capitalFromRow } from "./leaderData.js";
import { type Fetch, canonicalJson, env, requireEnv } from "./util.js";

export interface TrackRecord {
  schema: "copas.trackrecord.v1";
  address: string;
  chainId: 143;
  venue: "perpl";
  asOf: number; // unix s
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  fillsUsed: number;
  complete: boolean; // false if the fill history was capped
  pnl30d: string; // AUSD, official Perpl leaderboard (month)
  roi30dBps: number | null;
  volume30d: string;
  pnlAll: string; // realized net PnL over all fills used
  maxDrawdown: string; // AUSD on the realized curve
  maxDrawdownPct: number | null; // of the Perpl ROI capital base
  winRateBps: number;
  closedTrades: number;
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

export function buildTrackRecord(address: string, fills: Fill[], row: { pnl: number; roi: number; volume: number } | null, asOf: number, complete: boolean, source: string): TrackRecord {
  const trades = closedTrades(fills);
  const st = computeStats(fills, trades, { from: fills[0]?.ts ?? asOf, to: asOf });
  const cap = capitalFromRow(row as any);
  const mdd = maxDrawdown(equityCurve(fills).map((p) => p.cumNetPnl));
  return {
    schema: "copas.trackrecord.v1",
    address: address.toLowerCase(),
    chainId: 143,
    venue: "perpl",
    asOf,
    firstTradeAt: fills[0]?.ts ?? null,
    lastTradeAt: st.lastTradeAt,
    fillsUsed: fills.length,
    complete,
    pnl30d: s6(row?.pnl ?? 0),
    roi30dBps: row ? Math.round(row.roi * 10_000) : null,
    volume30d: s6(row?.volume ?? 0),
    pnlAll: s6(st.netPnl),
    maxDrawdown: s6(mdd),
    maxDrawdownPct: cap ? Math.round((mdd / cap) * 10_000) / 100 : null,
    winRateBps: Math.round(st.winRate * 10_000),
    closedTrades: st.closedTrades,
    sources: ["https://app.perpl.xyz/api/v1/trading/leaderboard/month/pnl", source],
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

export async function attest(address: string, opts: { fetch?: Fetch; now?: number; maxFills?: number } = {}): Promise<Attestation> {
  requireEnv("ATTESTER_PRIVATE_KEY"); // fail fast before any fetch
  const f = opts.fetch ?? fetch;
  const asOf = opts.now ?? Math.floor(Date.now() / 1000);
  const max = opts.maxFills ?? 5000;
  const envio = env("ENVIO_GRAPHQL_URL");
  const [fills, board] = await Promise.all([
    envio ? fetchEnvioFills(envio, address, 0, asOf, f) : fetchPlumbFills(address, 0, asOf, f, max),
    fetchLeaderboard("month", "pnl", f),
  ]);
  const row = board.find((r) => r.address === address.toLowerCase()) ?? null;
  const record = buildTrackRecord(address, fills, row, asOf, fills.length < max, envio ? "envio:copas-indexer" : "https://plumb.huginn.tech/api/v1/wallets/:addr/trades");
  return signTrackRecord(record);
}
