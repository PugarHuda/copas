import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { encode } from "../../lib/core.ts";
import { commonInputs, resolveVault, send, type Sent, session, vaultInput, fail } from "../../lib/host.ts";

const inputs = { ...vaultInput, ...commonInputs } satisfies InputSchema;

type Result = { vault: Address; leader: Address; tx: Sent };

export default class CopasUnfollow extends PluginCommand<Result> {
  static override description = "Stop copying. Open positions unwind on the next sync (target becomes 0).";
  static override examples = ["<%= config.bin %> copas unfollow"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:unfollow";

  async execute(io: CommandIO): Promise<Result> {
    const { vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const vault = await resolveVault(this.ctx, s, rawVault);
    if (!(await s.read<boolean>(vault, "FollowerVault", "following"))) throw fail("COPAS_NOT_FOLLOWING", "This vault is not following anyone.");
    const leader = await s.read<Address>(vault, "FollowerVault", "leader");
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.unfollow(vault), `unfollow ${leader}`, { vault });
    return { vault, leader, tx };
  }

  override successHint(): string {
    return "Unfollowed. Run 'mm copas sync <market>' for each open market to close positions now.";
  }
}
