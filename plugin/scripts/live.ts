// Live harness: runs one `mm copas` command handler against a real chain without the host CLI
// (the host needs `mm login`, which is interactive). It supplies the same three context members the
// plugin uses: publicClient, walletStateManager (active address) and walletExecutor, the latter backed
// by a local key so writes are real transactions. Test/dev only; the published plugin never sees keys.
//
//   COPAS_LIVE_KEY=0x... node scripts/live.ts leaders --chain-id 10143
//   COPAS_LIVE_KEY=0x... node scripts/live.ts follow 0xLeader --ratio 0.5 ... --yes --chain-id 10143
// Without COPAS_LIVE_KEY only read commands work (COPAS_LIVE_ADDRESS sets the address they read for).
import { mergeArgsIntoFlags, resolveInputs } from "@metamask/agent-wallet/plugin";
import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC: Record<number, string> = {
  143: process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz",
  10143: process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz",
};
const chain = (id: number) => defineChain({ id, name: `monad-${id}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC[id]] } } });

const [name, ...rest] = process.argv.slice(2);
if (!name) throw new Error("usage: node scripts/live.ts <command> [args] [--flag value]");
const positional: string[] = [];
let flags: Record<string, unknown> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) positional.push(a);
  else if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) flags[a.slice(2)] = true;
  else flags[a.slice(2)] = rest[++i];
}

const Cmd = (await import(`../src/commands/copas/${name}.ts`)).default;
const args = Object.fromEntries(Object.keys(Cmd.args ?? {}).map((k, i) => [k, positional[i]]).filter(([, v]) => v !== undefined));
flags = mergeArgsIntoFlags(flags, args);

const key = process.env.COPAS_LIVE_KEY as Hex | undefined;
const account = key ? privateKeyToAccount(key) : undefined;
const address = (account?.address ?? process.env.COPAS_LIVE_ADDRESS) as Address | undefined;
const clients = new Map<number, ReturnType<typeof createPublicClient>>();
const publicClient = (id: number) => clients.get(id) ?? clients.set(id, createPublicClient({ chain: chain(id), transport: http(RPC[id]) })).get(id)!;

const ctx = {
  publicClient,
  walletStateManager: { read: () => ({ selectedWallet: address ? { ref: { address } } : undefined }) },
  walletExecutor: async () => async (req: { chainId: number; transaction: { to: Address; data: Hex }; intent: { summary: string } }) => {
    if (!account) throw new Error("COPAS_LIVE_KEY not set: write commands need a signer");
    const w = createWalletClient({ account, chain: chain(req.chainId), transport: http(RPC[req.chainId]) });
    const hash = await w.sendTransaction(req.transaction);
    const r = await publicClient(req.chainId).waitForTransactionReceipt({ hash });
    console.error(`[tx] ${req.intent.summary}: ${hash} ${r.status}`);
    return { kind: "transaction", hash, status: r.status === "success" ? "CONFIRMED" : "FAILED" };
  },
};

const io = {
  isInteractive: false,
  flags,
  signal: new AbortController().signal,
  emit: (t: string) => console.error(t),
  yield: () => {},
  notify: (n: { message: string }) => console.error(n.message),
  progress: () => {},
  log: () => {},
  resolveInputs: (schema: never) => resolveInputs(schema, flags, null),
};

const cmd = Object.create(Cmd.prototype);
Object.assign(cmd, { ctx, pluginCommandId: `copas:${name}` });
try {
  const out = await cmd.execute(io);
  console.log(JSON.stringify({ ok: true, data: out, hint: cmd.successHint?.(out) }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} catch (e) {
  const err = e as { code?: string; message: string; hint?: string };
  console.log(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, hint: err.hint } }, null, 2));
  process.exitCode = 1;
}
