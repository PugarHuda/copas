import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "@/lib/chains";

export const dynamic = "force-dynamic";

// Testnet only: gas MON from our key + 10k AUSD from the Perpl testnet faucet contract, so judges can try Copas.
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const AUSD_FAUCET = "0xd236c18d274e54faccc3dd9dda4b27965a73ee6c"; // requestFunds(address) -> 10k AUSD
const abi = parseAbi(["function requestFunds(address)", "function balanceOf(address) view returns (uint256)"]);
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
// ponytail: per-instance memory, resets on redeploy; a KV store if abuse ever matters on a testnet faucet
const last = new Map<string, number>();

export async function POST(req: Request) {
  const key = process.env.TESTNET_FAUCET_KEY as `0x${string}` | undefined;
  if (!key) return NextResponse.json({ error: "faucet-off" }, { status: 503 });
  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad-address" }, { status: 400 });
  const a = address.toLowerCase() as `0x${string}`;
  if (Date.now() - (last.get(a) ?? 0) < 3_600_000) return NextResponse.json({ error: "cooldown" }, { status: 429 });
  last.set(a, Date.now());

  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: monadTestnet, transport: http() });
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
    return NextResponse.json({ error: e instanceof Error ? e.message.split("\n")[0] : "tx-failed" }, { status: 502 });
  }
}
