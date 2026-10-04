import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { type Address, maxUint256 } from "viem";
import { encode, parsePerpId, symbolOf } from "../../lib/core.ts";
import { commonInputs, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Market symbol (BTC, ETH, SOL, MON) or Perpl perp id", required: true, index: 0 },
  ...vaultInput,
  ...commonInputs,
} satisfies InputSchema;

type Result = { vault: Address; market: string; perpId: number; tx: Sent };

export default class CopasSync extends PluginCommand<Result> {
  static override description =
    "Move the vault's position in one market toward ratio x the leader's live position, inside your limits (copy-only; it cannot open anything the leader does not hold).";
  static override examples = ["<%= config.bin %> copas sync BTC"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:sync";

  async execute(io: CommandIO): Promise<Result> {
    const { market, vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const perpId = wrap(() => parsePerpId(market, s.chainId));
    const idx = await s.read<bigint>(s.dep.registry, "CopasRegistry", "indexOf", [BigInt(perpId)]);
    if (idx === maxUint256) throw fail("COPAS_MARKET_NOT_LISTED", `Perp ${perpId} is not in the Copas registry.`);
    const vault = await resolveVault(this.ctx, s, rawVault);
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.sync(vault, perpId), `sync ${symbolOf(s.chainId, perpId)}`, { vault, perpId: String(perpId) });
    return { vault, market: symbolOf(s.chainId, perpId), perpId, tx };
  }
}
