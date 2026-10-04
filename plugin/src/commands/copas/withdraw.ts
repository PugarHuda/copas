import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { checkWithdrawCap, encode, fmtAusd, parseAusd } from "../../lib/core.ts";
import { appendWithdraw, commonInputs, maxWithdrawPerDay, readWithdrawLedger, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";

const inputs = {
  amount: { type: InputFieldType.Text, flag: "amount", message: "AUSD amount to withdraw to your wallet", required: true, index: 0 },
  ...vaultInput,
  ...commonInputs,
} satisfies InputSchema;

type Result = { vault: Address; withdrawn: string; usedLast24h: string; dailyCap: string; tx: Sent };

export default class CopasWithdraw extends PluginCommand<Result> {
  static override description = "Withdraw AUSD from your vault to your wallet. The plugin's rolling 24h outflow cap (maxWithdrawPerDay) is checked before the tx is built.";
  static override examples = ["<%= config.bin %> copas withdraw 10"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:withdraw";

  async execute(io: CommandIO): Promise<Result> {
    const { amount: raw, vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const amount = wrap(() => parseAusd(raw));
    const cap = maxWithdrawPerDay();
    const used = wrap(() => checkWithdrawCap(readWithdrawLedger(), amount, cap, Date.now()));
    const s = session(this.ctx, chainId);
    const vault = await resolveVault(this.ctx, s, rawVault);
    const [eq] = await s.read<readonly [bigint, boolean]>(vault, "FollowerVault", "equity");
    if (amount > eq) throw fail("COPAS_INSUFFICIENT_EQUITY", `Vault equity is ${fmtAusd(eq)}; cannot withdraw ${fmtAusd(amount)}.`);
    const tx = await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.withdraw(vault, amount), `withdraw ${fmtAusd(amount)}`, { vault });
    appendWithdraw({ ts: Date.now(), amount: amount.toString(), chainId: s.chainId, vault });
    return { vault, withdrawn: fmtAusd(amount), usedLast24h: fmtAusd(used + amount), dailyCap: fmtAusd(cap), tx };
  }
}
