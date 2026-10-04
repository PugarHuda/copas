import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { buildTightenParams, describeParams, encode } from "../../lib/core.ts";
import { commonInputs, readParams, registryMarkets, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";
import { limitInputs } from "./follow.ts";

const inputs = { ...limitInputs, ...vaultInput, ...commonInputs } satisfies InputSchema;

type Result = { vault: Address; before: ReturnType<typeof describeParams>; after: ReturnType<typeof describeParams>; tx: Sent };

export default class CopasTighten extends PluginCommand<Result> {
  static override description = "Lower one or more follow limits. Only risk-reducing changes are accepted (enforced here and in the contract).";
  static override examples = ["<%= config.bin %> copas tighten --max-leverage 2 --markets BTC", "<%= config.bin %> copas tighten --ratio 0.25"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:tighten";

  async execute(io: CommandIO): Promise<Result> {
    const f = await io.resolveInputs(inputs);
    const s = session(this.ctx, f.chainId);
    const vault = await resolveVault(this.ctx, s, f.vault);
    if (!(await s.read<boolean>(vault, "FollowerVault", "following"))) throw fail("COPAS_NOT_FOLLOWING", "This vault is not following anyone.");
    const markets = await registryMarkets(s);
    const current = await readParams(s, vault);
    const next = wrap(() => buildTightenParams(current, f, s.chainId, markets));
    const before = describeParams(current, s.chainId, markets);
    const after = describeParams(next, s.chainId, markets);
    if (JSON.stringify(before) === JSON.stringify(after)) throw fail("COPAS_NOTHING_TO_CHANGE", "No limit changed. Pass at least one lower limit.");
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.tighten(vault, next), "tighten limits", { vault });
    return { vault, before, after, tx };
  }
}
