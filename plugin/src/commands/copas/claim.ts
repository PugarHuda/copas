import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { encode, fmtAusd, parseAddress } from "../../lib/core.ts";
import { commonInputs, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";

const inputs = {
  leader: { type: InputFieldType.Text, flag: "leader", message: "LeaderBook that breached", required: true, index: 0 },
  epoch: { type: InputFieldType.Text, flag: "epoch", message: "Breached epoch number", required: true, index: 1 },
  ...vaultInput,
  ...commonInputs,
} satisfies InputSchema;

type Result = { vault: Address; leader: Address; epoch: string; loss: string; tx: Sent };

export default class CopasClaim extends PluginCommand<Result> {
  static override description = "Claim your share of a breached leader's slashed bond for an epoch. Paid straight to your wallet.";
  static override examples = ["<%= config.bin %> copas claim 0xLeaderBook 3"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:claim";

  async execute(io: CommandIO): Promise<Result> {
    const { leader, epoch: rawEpoch, vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const lb = wrap(() => parseAddress(leader, "leader"));
    if (!/^\d+$/.test(rawEpoch)) throw fail("COPAS_INVALID_EPOCH", `Epoch must be a whole number, got '${rawEpoch}'.`);
    const epoch = BigInt(rawEpoch);
    const vault = await resolveVault(this.ctx, s, rawVault);
    // Same checks the contract makes, so the user gets a readable error instead of a revert.
    const [breached, eligible, claimed, loss] = await Promise.all([
      s.read<boolean>(lb, "LeaderBook", "breached", [epoch]),
      s.read<boolean>(lb, "LeaderBook", "eligible", [vault, epoch]),
      s.read<boolean>(lb, "LeaderBook", "claimed", [epoch, vault]),
      s.read<bigint>(vault, "FollowerVault", "lossIn", [epoch]),
    ]);
    if (!breached) throw fail("COPAS_NO_BREACH", `Leader did not breach in epoch ${epoch}.`);
    if (!eligible) throw fail("COPAS_NOT_ELIGIBLE", `This vault was not following ${lb} for all of epoch ${epoch}.`);
    if (claimed) throw fail("COPAS_ALREADY_CLAIMED", `Epoch ${epoch} is already claimed.`);
    if (loss === 0n) throw fail("COPAS_NOTHING_TO_CLAIM", `No loss recorded for epoch ${epoch}; nothing to claim.`);
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.claim(vault, lb, epoch), `claim epoch ${epoch}`, { vault, leader: lb, loss: fmtAusd(loss) });
    return { vault, leader: lb, epoch: epoch.toString(), loss: fmtAusd(loss), tx };
  }
}
