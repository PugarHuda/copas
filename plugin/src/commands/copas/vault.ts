import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { encode, fmtAusd } from "../../lib/core.ts";
import { activeAddress, commonInputs, maybeSetReferrer, refInput, send, type Sent, session } from "../../lib/host.ts";

const inputs = {
  create: { type: InputFieldType.Boolean, flag: "create", message: "Create a FollowerVault if you have none", required: false, prompt: false },
  ...refInput,
  ...commonInputs,
} satisfies InputSchema;

type Result = { owner: Address; chainId: number; vaults: Address[]; active: Address | null; depositCap: string; txs: Sent[] };

export default class CopasVault extends PluginCommand<Result> {
  static override description = "Show your Copas FollowerVault(s), or create one with --create. Optional one-time --ref sets a referrer.";
  static override examples = ["<%= config.bin %> copas vault", "<%= config.bin %> copas vault --create", "<%= config.bin %> copas vault --ref 0xReferrer"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:vault";

  async execute(io: CommandIO): Promise<Result> {
    const { create, ref, chainId } = await io.resolveInputs(inputs);
    const s = session(this.ctx, chainId);
    const owner = activeAddress(this.ctx);
    const vaultsOf = () => s.read<readonly Address[]>(s.dep.registry, "CopasRegistry", "vaultsOf", [owner]);
    let vaults = [...(await vaultsOf())];
    const txs: Sent[] = [];
    if (create && vaults.length === 0) {
      txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.createVault(s.dep.registry), "create FollowerVault", { registry: s.dep.registry }));
      vaults = [...(await vaultsOf())];
    } else if (create) {
      io.emit(`You already have a vault (${vaults.at(-1)}); not creating another.`);
    }
    const active = vaults.at(-1) ?? null;
    if (ref && active) {
      const t = await maybeSetReferrer(this.ctx, io, this.pluginCommandId, s, active, ref, owner);
      if (t) txs.push(t);
    }
    const cap = await s.read<bigint>(s.dep.registry, "CopasRegistry", "maxVaultDepositCNS");
    return { owner, chainId: s.chainId, vaults, active, depositCap: fmtAusd(cap), txs };
  }

  override successHint(d: Result): string {
    return d.active ? `Active vault ${d.active}. Next: mm copas deposit <amount>` : "No vault yet. Run: mm copas vault --create";
  }
}
