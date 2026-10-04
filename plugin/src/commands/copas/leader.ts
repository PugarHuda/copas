import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { parseAddress } from "../../lib/core.ts";
import { commonInputs, registryMarkets, session, wrap, fail } from "../../lib/host.ts";
import { breachHistory, leaderSummary } from "../../lib/views.ts";

import type { Address } from "viem";

const inputs = {
  leader: { type: InputFieldType.Text, flag: "leader", message: "LeaderBook address", required: true, index: 0 },
  ...commonInputs,
} satisfies InputSchema;

export default class CopasLeader extends PluginCommand<Record<string, unknown>> {
  static override description = "Show one Copas leader: mandate, current drawdown vs mandate, bond/protection, and breach history.";
  static override examples = ["<%= config.bin %> copas leader 0xLeaderBook"];
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:leader";

  async execute(io: CommandIO) {
    const { leader, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const lb = wrap(() => parseAddress(leader, "leader"));
    if (!(await s.read<boolean>(s.dep.registry, "CopasRegistry", "isLeaderBook", [lb]))) {
      throw fail("COPAS_NOT_A_LEADER", `${lb} is not a Copas LeaderBook on chain ${s.chainId}.`, "List leaders with 'mm copas leaders'.");
    }
    const markets = await registryMarkets(s);
    const { _raw, ...summary } = await leaderSummary(s, lb, markets);
    const [operator, epochEnd, breaches] = await Promise.all([
      s.read<Address>(lb, "LeaderBook", "operator"),
      s.read<bigint>(lb, "LeaderBook", "epochEnd"),
      breachHistory(s, lb, _raw.epoch),
    ]);
    return {
      ...summary,
      operator,
      epochEndsAt: epochEnd > 0n ? new Date(Number(epochEnd) * 1000).toISOString() : null,
      drawdownHeadroom: `${((_raw.maxDDbps - _raw.ddBps) / 100).toFixed(2)}% before a drawdown breach`,
      breaches,
    };
  }
}
