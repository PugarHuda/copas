import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { commonInputs, registryMarkets, session } from "../../lib/host.ts";
import { leaderSummary } from "../../lib/views.ts";

const inputs = { ...commonInputs } satisfies InputSchema;

type Result = { chainId: number; leaders: Omit<Awaited<ReturnType<typeof leaderSummary>>, "_raw">[] };

export default class CopasLeaders extends PluginCommand<Result> {
  static override description = "List bonded Copas leaders: status, bond, mandate, epoch, unit price, protection and capacity.";
  static override examples = ["<%= config.bin %> copas leaders", "<%= config.bin %> copas leaders --chain-id 10143 --json"];
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:leaders";

  async execute(io: CommandIO): Promise<Result> {
    const { chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const [count, markets] = await Promise.all([s.read<bigint>(s.dep.registry, "CopasRegistry", "leaderCount"), registryMarkets(s)]);
    const books = await Promise.all(Array.from({ length: Number(count) }, (_, i) => s.read<Address>(s.dep.registry, "CopasRegistry", "leaderBooks", [BigInt(i)])));
    const leaders = (await Promise.all(books.map((lb) => leaderSummary(s, lb, markets)))).map(({ _raw, ...rest }) => rest);
    // Active leaders first, then by protection.
    leaders.sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active"));
    return { chainId: s.chainId, leaders };
  }

  override successHint(d: Result): string {
    return d.leaders.length ? `${d.leaders.length} leader(s). Inspect one with: mm copas leader <address>` : "No leaders registered yet.";
  }
}
