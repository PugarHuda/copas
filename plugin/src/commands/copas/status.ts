import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { commonInputs, registryMarkets, resolveVault, session, vaultInput } from "../../lib/host.ts";
import { vaultStatus } from "../../lib/views.ts";

const inputs = { ...vaultInput, ...commonInputs } satisfies InputSchema;

type Result = Awaited<ReturnType<typeof vaultStatus>>;

export default class CopasStatus extends PluginCommand<Result> {
  static override description = "Your vault: equity, epoch PnL, open positions, current limits and claimable breach payouts.";
  static override examples = ["<%= config.bin %> copas status", "<%= config.bin %> copas status --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:status";

  async execute(io: CommandIO): Promise<Result> {
    const { vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const vault = await resolveVault(this.ctx, s, rawVault);
    return vaultStatus(s, vault, await registryMarkets(s));
  }

  override successHint(d: Result): string {
    return d.claimable.length ? `${d.claimable.length} claimable breach payout(s): ${d.claimable[0].command}` : `Equity ${d.equity}, epoch PnL ${d.epochPnl}.`;
  }
}
