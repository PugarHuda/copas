import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { createPublicClient, createWalletClient, isAddress, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet, rpcTransport } from "@/lib/chains";

export const dynamic = "force-dynamic";

// Testnet only: gas MON from our key + 10k AUSD from the Perpl testnet faucet contract, so judges can try Copas.
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const AUSD_FAUCET = "0xd236c18d274e54faccc3dd9dda4b27965a73ee6c"; // requestFunds(address) -> 10k AUSD
const abi = parseAbi(["function requestFunds(address)", "function balanceOf(address) view returns (uint256)"]);
const pub = createPublicClient({ chain: monadTestnet, transport: rpcTransport(monadTestnet) });
const DAY = 86_400_000;
const PER_IP_PER_DAY = 3; // fresh addresses are free to make, so the IP is what bounds the MON we give away
const last = new Map<string, number>(); // fast path for this instance; the durable record is the blob below

/** Grant times (ms) for one key, from a private Vercel Blob shared by every instance. */
async function grants(k: string): Promise<number[]> {
  const r = await get(`faucet/${k}.json`, { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return [];
  const t = (JSON.parse(await new Response(r.stream).text()) as { t?: number[] }).t ?? [];
  return t.filter((x) => Date.now() - x < DAY);
}
// ponytail: read-then-write, so two simultaneous requests can both pass; bounds abuse to a handful of grants per race
const record = (k: string, t: number[]) =>
  put(`faucet/${k}.json`, JSON.stringify({ t }), { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" });

export async function POST(req: Request) {
  const key = process.env.TESTNET_FAUCET_KEY as `0x${string}` | undefined;
  if (!key) return NextResponse.json({ error: "faucet-off" }, { status: 503 });
  const body: unknown = await req.json().catch(() => null);
  const address = body && typeof body === "object" ? (body as { address?: unknown }).address : undefined;
  if (typeof address !== "string" || !isAddress(address)) return NextResponse.json({ error: "bad-address" }, { status: 400 });
  const a = address.toLowerCase() as `0x${string}`;
  if (Date.now() - (last.get(a) ?? 0) < DAY) return NextResponse.json({ error: "cooldown" }, { status: 429 });
  const ip = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  const ipKey = `ip/${createHash("sha256").update(`copas-faucet:${ip}`).digest("hex").slice(0, 32)}`;
  const [byAddr, byIp] = await Promise.all([grants(`addr/${a}`), grants(ipKey)]);
  if (byAddr.length || byIp.length >= PER_IP_PER_DAY) return NextResponse.json({ error: "cooldown" }, { status: 429 });
  last.set(a, Date.now());
  await Promise.all([record(`addr/${a}`, [Date.now()]), record(ipKey, [...byIp, Date.now()])]);

  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: monadTestnet, transport: rpcTransport(monadTestnet) });
  try {
    // Sequential: a second tx sent before the first confirms fails with a stale nonce on Monad RPC.
    const sent: `0x${string}`[] = [];
    const confirm = async (h: `0x${string}`) => (sent.push(h), pub.waitForTransactionReceipt({ hash: h }));
    if ((await pub.getBalance({ address: a })) < parseEther("0.5")) await confirm(await wallet.sendTransaction({ to: a, value: parseEther("1") }));
    if ((await pub.readContract({ address: AUSD, abi, functionName: "balanceOf", args: [a] })) < 500_000_000n)
      await confirm(await wallet.writeContract({ address: AUSD_FAUCET, abi, functionName: "requestFunds", args: [a] }));
    return NextResponse.json({ txs: sent });
  } catch (e) {
    last.delete(a);
    await Promise.all([record(`addr/${a}`, []), record(ipKey, byIp)]).catch(() => null); // failed grant: give the slot back
    return NextResponse.json({ error: e instanceof Error ? e.message.split("\n")[0] : "tx-failed" }, { status: 502 });
  }
}
