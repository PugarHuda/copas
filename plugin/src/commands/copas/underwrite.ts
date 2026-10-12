import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { type Address, erc20Abi, zeroAddress } from "viem";
import { encode, fmtAusd, parseAddress, parseAusd } from "../../lib/core.ts";
import { activeAddress, commonInputs, fail, send, type Sent, session, wrap } from "../../lib/host.ts";

const inputs = {
  leader: { type: InputFieldType.Text, flag: "leader", message: "LeaderBook whose underwriter pool to back", required: true, index: 0 },
  amount: { type: InputFieldType.Text, flag: "amount", message: "AUSD to deposit (omit to just show your position)", required: false, prompt: false, index: 1 },
  exit: {
    type: InputFieldType.Boolean,
    flag: "exit",
    message: "Leave the pool: requests withdrawal of all shares, or withdraws once the unbond delay has passed",
    required: false,
    prompt: false,
  },
  ...commonInputs,
} satisfies InputSchema;

type Result = {
  leader: Address;
  pool: Address;
  underwriter: Address;
  poolAssets: string;
  yourShares: string;
  yourValue: string;
  pendingShares: string;
  unlockEpoch: string;
  leaderEpoch: string;
  leaderProtection: string;
  txs: Sent[];
};

export default class CopasUnderwrite extends PluginCommand<Result> {
  static override description =
    "Back a leader's bond as an underwriter: AUSD into its UnderwriterPool. You earn a share of the leader's released fees and are slashed after the leader's own bond on a breach. --exit requests, then finishes, withdrawal (one unbond epoch delay).";
  static override examples = [
    "<%= config.bin %> copas underwrite 0xLeaderBook",
    "<%= config.bin %> copas underwrite 0xLeaderBook 50 --chain-id 10143",
    "<%= config.bin %> copas underwrite 0xLeaderBook --exit",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:underwrite";

  async execute(io: CommandIO): Promise<Result> {
    const { leader, amount: rawAmount, exit, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const lb = wrap(() => parseAddress(leader, "leader"));
    if (rawAmount && exit) throw fail("COPAS_INVALID_ARGS", "Give an amount to deposit or --exit, not both.");
    if (!(await s.read<boolean>(s.dep.registry, "CopasRegistry", "isLeaderBook", [lb]))) throw fail("COPAS_NOT_A_LEADER", `${lb} is not a Copas LeaderBook on chain ${s.chainId}.`);
    const pool = await s.read<Address>(lb, "LeaderBook", "pool");
    if (pool === zeroAddress) throw fail("COPAS_NO_POOL", "This leader has no underwriter pool.");
    const me = activeAddress(this.ctx);
    const state = () =>
      s.many<[bigint, bigint, bigint, bigint, bigint, bigint, bigint, number]>([
        { address: pool, name: "UnderwriterPool", fn: "assets" },
        { address: pool, name: "UnderwriterPool", fn: "sharesOf", args: [me] },
        { address: pool, name: "UnderwriterPool", fn: "valueOf", args: [me] },
        { address: pool, name: "UnderwriterPool", fn: "pendingShares", args: [me] },
        { address: pool, name: "UnderwriterPool", fn: "unlockEpoch", args: [me] },
        { address: lb, name: "LeaderBook", fn: "epoch" },
        { address: lb, name: "LeaderBook", fn: "protection" },
        { address: lb, name: "LeaderBook", fn: "status" },
      ]);
    const [, shares, , pending, unlock, epoch, , status] = await state();
    const txs: Sent[] = [];

    if (rawAmount) {
      const amount = wrap(() => parseAusd(rawAmount));
      if (Number(status) === 2) throw fail("COPAS_LEADER_BREACHED", "Leader is Breached and its pool was slashed; refusing to back a closed book.");
      const bal = await s.client.readContract({ address: s.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      if (bal < amount) throw fail("COPAS_INSUFFICIENT_BALANCE", `Wallet holds ${fmtAusd(bal)}; cannot underwrite ${fmtAusd(amount)}.`);
      io.emit(`Underwriters are slashed after the leader's own bond if it breaks its mandate. You can lose up to ${fmtAusd(amount)}.`);
      txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.approve(s.dep.ausd, pool, amount), `approve ${fmtAusd(amount)} to underwriter pool`, { pool }));
      txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.uwDeposit(pool, amount), `underwrite ${fmtAusd(amount)}`, { leader: lb, pool }));
    } else if (exit) {
      if (pending > 0n && epoch >= unlock) {
        txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.uwWithdraw(pool), "withdraw underwriter shares", { pool }));
      } else if (pending > 0n) {
        throw fail("COPAS_TOO_EARLY", `Withdrawal of ${pending} shares unlocks at leader epoch ${unlock} (now ${epoch}).`, "Run again after the leader rolls into that epoch.");
      } else {
        if (shares === 0n) throw fail("COPAS_NOTHING_TO_CLAIM", "You hold no shares in this pool.");
        txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.uwRequestWithdraw(pool, shares), "request underwriter withdrawal", { pool, shares: shares.toString() }));
      }
    }

    const [assets, sh, value, pend, unl, ep, protection] = await state();
    return {
      leader: lb,
      pool,
      underwriter: me,
      poolAssets: fmtAusd(assets),
      yourShares: sh.toString(),
      yourValue: fmtAusd(value),
      pendingShares: pend.toString(),
      unlockEpoch: unl.toString(),
      leaderEpoch: ep.toString(),
      leaderProtection: fmtAusd(protection),
      txs,
    };
  }

  override successHint(d: Result): string {
    return d.pendingShares !== "0" ? `Withdrawal pending; unlocks at leader epoch ${d.unlockEpoch}. Re-run with --exit then.` : `Pool ${d.poolAssets}; your stake ${d.yourValue}.`;
  }
}
