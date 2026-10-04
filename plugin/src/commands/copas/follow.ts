import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { buildFollowParams, describeParams, encode, fmtAusd, marketsFromMask, parseAddress, riskDisclosure } from "../../lib/core.ts";
import { activeAddress, commonInputs, maybeSetReferrer, refInput, registryMarkets, resolveVault, send, type Sent, session, vaultInput, wrap, fail } from "../../lib/host.ts";
import { leaderSummary } from "../../lib/views.ts";

const text = (flag: string, message: string) => ({ type: InputFieldType.Text, flag, message, required: false, prompt: false }) as const;

export const limitInputs = {
  ratio: text("ratio", "Copy ratio as a multiple of the leader's size, e.g. 0.25 (max 5)"),
  maxNotional: text("max-notional", "Max exposure in AUSD notional"),
  maxLeverage: text("max-leverage", "Max leverage, e.g. 3 or 2.5x"),
  chaseBps: text("chase-bps", "Skip adding when mark is this many bps from the leader's entry (0-2000)"),
  bandBps: text("band-bps", "IOC price band around mark in bps (1-500)"),
  stopLossBps: text("stop-loss-bps", "Pause copying when vault equity drops this many bps within an epoch (1-10000)"),
  markets: text("markets", "Comma-separated markets, e.g. BTC,ETH"),
} as const;

const mainInputs = {
  leader: { type: InputFieldType.Text, flag: "leader", message: "LeaderBook address to follow", required: true, index: 0 },
  ...limitInputs,
  ...refInput,
  ...vaultInput,
  ...commonInputs,
} satisfies InputSchema;

const confirmInput = {
  yes: { type: InputFieldType.Confirm, flag: "yes", message: "I have read the risk disclosure above. Follow this leader with these limits?", required: true },
} satisfies InputSchema;

type Result = { vault: Address; leader: Address; limits: ReturnType<typeof describeParams>; disclosure: string; txs: Sent[] };

export default class CopasFollow extends PluginCommand<Result> {
  static override description =
    "Follow a bonded leader from your FollowerVault with explicit, mandatory risk limits. Shows a risk disclosure (max protection = bond / AUM) and requires confirmation (--yes when non-interactive).";
  static override examples = [
    "<%= config.bin %> copas follow 0xLeaderBook --ratio 0.5 --max-notional 50 --max-leverage 3 --chase-bps 50 --band-bps 30 --stop-loss-bps 1500 --markets BTC,ETH",
  ];
  static override flags = schemaToFlags({ ...mainInputs, ...confirmInput });
  static override args = schemaToArgs(mainInputs);
  protected readonly pluginCommandId = "copas:follow";

  async execute(io: CommandIO): Promise<Result> {
    const f = await io.resolveInputs(mainInputs);
    const s = session(this.ctx, f.chainId);
    const lb = wrap(() => parseAddress(f.leader, "leader"));
    const markets = await registryMarkets(s);
    // Refuses before any chain write if a single limit is missing or out of range.
    const p = wrap(() => buildFollowParams(f, s.chainId, markets));

    if (!(await s.read<boolean>(s.dep.registry, "CopasRegistry", "isLeaderBook", [lb]))) throw fail("COPAS_NOT_A_LEADER", `${lb} is not a Copas LeaderBook.`);
    const vault = await resolveVault(this.ctx, s, f.vault);
    if (await s.read<boolean>(vault, "FollowerVault", "following")) throw fail("COPAS_ALREADY_FOLLOWING", "This vault already follows a leader.", "Use 'mm copas tighten' to lower limits, or 'mm copas unfollow' first.");

    const leader = await leaderSummary(s, lb, markets);
    if (leader.status !== "Active") throw fail("COPAS_LEADER_NOT_ACTIVE", `Leader status is ${leader.status}; new followers are blocked.`);
    const capacity = await s.read<bigint>(lb, "LeaderBook", "capacity");
    const aumAfter = leader._raw.aum + p.maxNotionalCNS;
    if (aumAfter > capacity) throw fail("COPAS_CAPACITY", `Leader capacity is ${fmtAusd(capacity)}; with you AUM would be ${fmtAusd(aumAfter)}.`, "Lower --max-notional.");
    const outside = marketsFromMask(p.marketsMask & ~(await s.read<{ marketsMask: bigint }>(lb, "LeaderBook", "mandate")).marketsMask, s.chainId, markets);
    if (outside.length) io.emit(`Note: the leader's mandate does not allow ${outside.join(", ")}; those markets will never be copied.`);

    const disclosure = riskDisclosure({ protection: leader._raw.protection, aumAfter, maxNotional: p.maxNotionalCNS, leaderMaxDDbps: leader._raw.maxDDbps });
    io.emit(disclosure);
    const { yes } = await io.resolveInputs(confirmInput);
    if (!yes) throw fail("COPAS_NOT_CONFIRMED", "Follow cancelled: risk disclosure not accepted.");

    const owner = activeAddress(this.ctx);
    const txs: Sent[] = [];
    const r = await maybeSetReferrer(this.ctx, io, this.pluginCommandId, s, vault, f.ref, owner);
    if (r) txs.push(r);
    const limits = describeParams(p, s.chainId, markets);
    txs.push(await send(this.ctx, io, this.pluginCommandId, s.chainId, encode.follow(vault, lb, p), `follow ${lb}`, { vault, ratio: limits.ratio, maxNotional: limits.maxNotional, maxLeverage: limits.maxLeverage, markets: limits.markets.join(",") }));
    return { vault, leader: lb, limits, disclosure, txs };
  }

  override successHint(d: Result): string {
    return `Following ${d.leader}. Copies happen via permissionless 'sync'; run 'mm copas sync <market>' to trigger one now.`;
  }
}
