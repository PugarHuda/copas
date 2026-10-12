import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { BREACH_REASON, encode, fmtAusd, LEADER_STATUS, parseAddress } from "../../lib/core.ts";
import { commonInputs, fail, send, type Sent, session, wrap } from "../../lib/host.ts";

const inputs = {
  leader: { type: InputFieldType.Text, flag: "leader", message: "LeaderBook to check against its mandate", required: true, index: 0 },
  ...commonInputs,
} satisfies InputSchema;

type Result = { leader: Address; epoch: string; before: string; after: string; breached: boolean; reason: string | null; slashedPot: string | null; tx: Sent };

export default class CopasCheckpoint extends PluginCommand<Result> {
  static override description =
    "Enforce a leader's mandate: permissionless LeaderBook.checkpoint(). If drawdown or leverage is past the mandate, the bond and underwriter pool are slashed into a pot that followers of that epoch claim with 'mm copas claim'.";
  static override examples = ["<%= config.bin %> copas checkpoint 0xLeaderBook --chain-id 10143"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:checkpoint";

  async execute(io: CommandIO): Promise<Result> {
    const { leader, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const lb = wrap(() => parseAddress(leader, "leader"));
    if (!(await s.read<boolean>(s.dep.registry, "CopasRegistry", "isLeaderBook", [lb]))) throw fail("COPAS_NOT_A_LEADER", `${lb} is not a Copas LeaderBook on chain ${s.chainId}.`);
    const [status, epoch] = await s.many<[number, bigint]>([
      { address: lb, name: "LeaderBook", fn: "status" },
      { address: lb, name: "LeaderBook", fn: "epoch" },
    ]);
    // checkpoint() is a no-op unless the leader is Active in a running epoch; say so instead of spending gas.
    if (Number(status) !== 0 || epoch === 0n) {
      throw fail("COPAS_NOTHING_TO_CHECK", `Leader is ${LEADER_STATUS[Number(status)]} (epoch ${epoch}); checkpoint only acts on an Active leader.`, `See 'mm copas leader ${lb}'.`);
    }
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.checkpoint(lb), `checkpoint ${lb}`, { leader: lb });
    const [after, b] = await s.many<[number, { reason: number; pot: bigint }]>([
      { address: lb, name: "LeaderBook", fn: "status" },
      { address: lb, name: "LeaderBook", fn: "breachOf", args: [epoch] },
    ]);
    const breached = Number(b.reason) !== 0;
    return {
      leader: lb,
      epoch: epoch.toString(),
      before: LEADER_STATUS[Number(status)],
      after: LEADER_STATUS[Number(after)],
      breached,
      reason: breached ? BREACH_REASON[Number(b.reason)] : null,
      slashedPot: breached ? fmtAusd(b.pot) : null,
      tx,
    };
  }

  override successHint(d: Result): string {
    return d.breached
      ? `Leader breached (${d.reason}); ${d.slashedPot} slashed. Followers of epoch ${d.epoch}: mm copas claim ${d.leader} ${d.epoch}`
      : "Mandate holds; nothing slashed.";
  }
}
