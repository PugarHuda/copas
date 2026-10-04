import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { type Address, erc20Abi } from "viem";
import { encode, fmtAusd, parseAusd } from "../../lib/core.ts";
import { activeAddress, commonInputs, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";

const inputs = {
  amount: { type: InputFieldType.Text, flag: "amount", message: "AUSD amount to deposit", required: true, index: 0 },
  ...vaultInput,
  ...commonInputs,
} satisfies InputSchema;

type Result = { vault: Address; deposited: string; txs: Sent[] };

export default class CopasDeposit extends PluginCommand<Result> {
  static override description = "Deposit AUSD into your FollowerVault (approve exact amount + deposit). Respects the registry per-vault cap.";
  static override examples = ["<%= config.bin %> copas deposit 25"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "copas:deposit";

  async execute(io: CommandIO): Promise<Result> {
    const { amount: raw, vault: rawVault, chainId } = await io.resolveInputs(inputs);
    const amount = wrap(() => parseAusd(raw));
    const s = session(this.ctx, chainId);
    const vault = await resolveVault(this.ctx, s, rawVault);
    const owner = activeAddress(this.ctx);

    const [[eq], cap, accountId, balance, allowance] = await Promise.all([
      s.read<readonly [bigint, boolean]>(vault, "FollowerVault", "equity"),
      s.read<bigint>(s.dep.registry, "CopasRegistry", "maxVaultDepositCNS"),
      s.read<bigint>(vault, "FollowerVault", "accountId"),
      s.client.readContract({ address: s.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      s.client.readContract({ address: s.dep.ausd, abi: erc20Abi, functionName: "allowance", args: [owner, vault] }),
    ]);
    if (eq + amount > cap) {
      throw fail("COPAS_DEPOSIT_CAP", `Deposit would take the vault to ${fmtAusd(eq + amount)}, above the per-vault cap of ${fmtAusd(cap)}.`, `Deposit at most ${fmtAusd(cap > eq ? cap - eq : 0n)}.`);
    }
    if (balance < amount) throw fail("COPAS_INSUFFICIENT_AUSD", `Wallet holds ${fmtAusd(balance)}, need ${fmtAusd(amount)}.`);
    if (accountId === 0n) {
      const min = await s.read<bigint>(s.dep.exchange, "PerplExchange", "getMinAccountOpenCNS");
      if (amount < min) throw fail("COPAS_BELOW_MIN_OPEN", `The first deposit opens a Perpl account and must be at least ${fmtAusd(min)}.`);
    }

    const txs: Sent[] = [];
    // Exact-amount approval: no standing unlimited allowance left behind.
    if (allowance < amount) txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.approve(s.dep.ausd, vault, amount), `approve ${fmtAusd(amount)}`, { spender: vault }));
    txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.deposit(vault, amount), `deposit ${fmtAusd(amount)}`, { vault }));
    return { vault, deposited: fmtAusd(amount), txs };
  }

  override successHint(d: Result): string {
    return `Deposited ${d.deposited} into ${d.vault}.`;
  }
}
