// ERC-8004 reputation for agent leaders: one feedback per finished epoch (+100 clean, -100 breached, tagged
// with the breach reason), written to the ReputationRegistry by a plain key that is not the agent's owner.
// Idempotent: this client's feedback count for an agent (getLastIndex) is the number of epochs already rated,
// so a rerun only rates epochs finished since. Feedback URI points at the leader page, which shows the reputation.
//   REPUTATION_PRIVATE_KEY=0x… pnpm exec tsx scripts/reputation.ts [--dry-run]
import { createWalletClient, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ABI, REPUTATION_8004, cfg, loadDeployments, log } from '../src/config.js';
import { chain, client, rpcTransport } from '../src/chain.js';
import { feedbackCall } from '../src/erc8004.js';

process.env.FEEDBACK_URI_BASE ||= 'https://copas-mocha.vercel.app';
const MAX_PER_RUN = Number(process.env.REPUTATION_MAX ?? 12); // ponytail: caps gas per run; reruns catch up
const dry = process.argv.includes('--dry-run');
const key = process.env.REPUTATION_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error('REPUTATION_PRIVATE_KEY not set');
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: rpcTransport() });
const rep = parseAbi(['function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)']);

const dep = loadDeployments();
const read = <T>(address: Address, abi: any, functionName: string, args: any[] = []) =>
  client.readContract({ address, abi, functionName, args }) as Promise<T>;

const n = await read<bigint>(dep.registry, ABI.registry, 'leaderCount');
const books = await Promise.all(Array.from({ length: Number(n) }, (_, i) => read<Address>(dep.registry, ABI.registry, 'leaderBooks', [BigInt(i)])));
let sent = 0;
for (const book of books) {
  const agentId = await read<bigint>(dep.agentRegistry, ABI.agentRegistry, 'agentOf', [book]);
  if (agentId === 0n) continue;
  const [epoch, done] = await Promise.all([read<bigint>(book, ABI.leader, 'epoch'), read<bigint>(REPUTATION_8004, rep, 'getLastIndex', [agentId, account.address])]);
  log('info', 'agent leader', { book, agentId, epoch, rated: done, rater: account.address });
  for (let e = done + 1n; e < epoch && sent < MAX_PER_RUN; e++) {
    const c = await feedbackCall(client, dep.agentRegistry, book, e);
    if (!c) break;
    if (dry) { log('info', 'dry-run feedback', { book, epoch: e, tag2: c.tag2 }); sent++; continue; }
    const hash = await wallet.sendTransaction({ to: c.to, data: c.data });
    const r = await client.waitForTransactionReceipt({ hash });
    log(r.status === 'success' ? 'info' : 'error', '8004 feedback', { book, agentId, epoch: e, tag2: c.tag2, hash, status: r.status });
    if (r.status !== 'success') process.exit(1);
    sent++;
  }
}
log('info', 'reputation done', { sent, chainId: cfg.chainId });
