"use client";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, erc20Abi, keccak256, parseAbi } from "viem";
import { Panel, Pill, Source } from "@/components/ui";
import { useL } from "@/lib/i18n/client";
import { PERPL, copasChain, explorerAddr, monad, rpcTransport } from "@/lib/chains";
import { copasPublic } from "@/lib/copas/useCopasWrite";
import { num, pct } from "@/lib/format";

const mainnet = createPublicClient({ chain: monad, transport: rpcTransport(monad) });

/** Agora Instant Settlement AUSD/USDC pair on Monad mainnet (docs.agora.finance/instant-settlement/protocol-deployments). */
const PAIR = "0xf33286E3222D1c829dACeac48c0Ec651F6452470" as const;
const pairAbi = parseAbi([
  "function getPrice() view returns (uint256)",
  "function reserve0() view returns (uint256)",
  "function reserve1() view returns (uint256)",
  "function token0PurchaseFee() view returns (uint256)",
  "function token1PurchaseFee() view returns (uint256)",
  "function isPaused() view returns (bool)",
]);
const ausdAbi = parseAbi(["function isMintPaused() view returns (bool)", "function isTransferPaused() view returns (bool)", "function isBurnFromPaused() view returns (bool)"]);

/**
 * Latest independent attestation, from the Grant Thornton LLP report Agora publishes at docs.agora.finance/developer/transparency.
 * ponytail: a PDF, not an API; update when Agora posts the next month's report.
 */
const ATTEST = {
  asOf: "31 Aug 2026",
  signed: "29 Sep 2026",
  circulating: 238_379_206,
  reserves: 239_090_456,
  pdf: "https://docs.agora.finance/_fern-files/agora.docs.buildwithfern.com/444c4f3a9642d6a9149e8fa9736469cd03192f55cc7ff3d2326117b0397875b5/docs/assets/2026%20Aug%20-%20Agora%20Dollar%20Reserve%20Report.pdf",
};

type Metrics = { partial: boolean; totalSupply?: string; chains: { network: string; totalSupply: string; circulatingSupply: string }[] };

/** AUSD from three sources that check each other: Agora's public API, Monad mainnet contracts, and the testnet token Perpl margins with. */
export function AusdFacts() {
  const L = useL();
  const testAusd = PERPL[copasChain.id as keyof typeof PERPL].ausd as `0x${string}`;
  const mainAusd = PERPL[monad.id].ausd as `0x${string}`;

  const api = useQuery({
    queryKey: ["agora-metrics"],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch("https://api.agora.finance/v0/metrics", { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`agora ${r.status}`);
      const j = (await r.json()) as Metrics;
      const ranked = [...j.chains].sort((a, b) => Number(b.totalSupply) - Number(a.totalSupply));
      const mon = j.chains.find((c) => c.network === "monad");
      return {
        total: "totalSupply" in j ? Number(j.totalSupply) : null,
        monTotal: mon ? Number(mon.totalSupply) : null,
        monCirc: mon ? Number(mon.circulatingSupply) : null,
        rank: ranked.findIndex((c) => c.network === "monad") + 1,
        chains: j.chains.length,
      };
    },
  });

  const chain = useQuery({
    queryKey: ["ausd-chain"],
    staleTime: 60_000,
    queryFn: async () => {
      const read = <T,>(p: Promise<T>) => p.catch(() => null);
      const [mainSupply, testSupply, price, r0, r1, f0, f1, pairPaused, mint, xfer, burn, codeMain, codeTest] = await Promise.all([
        read(mainnet.readContract({ address: mainAusd, abi: erc20Abi, functionName: "totalSupply" })),
        read(copasPublic.readContract({ address: testAusd, abi: erc20Abi, functionName: "totalSupply" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "getPrice" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "reserve0" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "reserve1" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "token0PurchaseFee" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "token1PurchaseFee" })),
        read(mainnet.readContract({ address: PAIR, abi: pairAbi, functionName: "isPaused" })),
        read(mainnet.readContract({ address: mainAusd, abi: ausdAbi, functionName: "isMintPaused" })),
        read(mainnet.readContract({ address: mainAusd, abi: ausdAbi, functionName: "isTransferPaused" })),
        read(mainnet.readContract({ address: mainAusd, abi: ausdAbi, functionName: "isBurnFromPaused" })),
        read(mainnet.getCode({ address: mainAusd })),
        read(copasPublic.getCode({ address: testAusd })),
      ]);
      const six = (v: bigint | null) => (v == null ? null : Number(v) / 1e6);
      return {
        main: six(mainSupply),
        test: six(testSupply),
        // token0 = AUSD, token1 = USDC, both 6 decimals: price is USDC per AUSD at 1e18 (PRICE_PRECISION)
        price: price == null ? null : Number(price) / 1e18,
        ausdRes: six(r0),
        usdcRes: six(r1),
        feeBps: f0 == null || f1 == null ? null : [Number(f0) / 1e14, Number(f1) / 1e14],
        pairPaused,
        paused: mint == null || xfer == null || burn == null ? null : { mint, xfer, burn },
        sameCode: codeMain && codeTest ? keccak256(codeMain) === keccak256(codeTest) : null,
      };
    },
  });

  const a = api.data, c = chain.data;
  const match = a?.monTotal != null && c?.main != null ? Math.abs(a.monTotal - c.main) < 1 : null;
  const cover = (ATTEST.reserves / ATTEST.circulating) * 100;
  const dd = "text-xs text-ink-3";
  const link = "underline text-ink-3";

  return (
    <Panel title="AUSD · Agora" aside={<><Source kind="live">api.agora.finance</Source><Source kind="rpc">Monad mainnet</Source></>}>
      <p className="text-sm text-ink-2">
        {L(
          "Dolar Agora adalah satu-satunya kolateral Perpl: margin, PnL, dan bond Copas semuanya AUSD. Diterbitkan Agora Bermuda Limited, dicek dari tiga sumber yang saling menguji.",
          "Agora's dollar is the only collateral Perpl takes, so your margin, PnL and any Copas bond are all AUSD. Issued by Agora Bermuda Limited, checked here from three sources that test each other.",
        )}
      </p>

      <h3 className="micro mt-4 text-ink-3">{L("Pasokan", "Supply")}</h3>
      <dl className="num mt-2 grid grid-cols-2 gap-3 text-sm" data-testid="ausd-supply">
        <div>
          <dt className={dd}>{L("Di Monad (API Agora)", "On Monad (Agora API)")}</dt>
          <dd>{a?.monTotal != null ? num(a.monTotal, 0) : api.isError ? "–" : "…"}</dd>
          {a?.monCirc != null && <dd className={dd}>{num(a.monCirc, 0)} {L("beredar", "circulating")}</dd>}
        </div>
        <div>
          <dt className={dd}>{L("Di Monad (totalSupply onchain)", "On Monad (onchain totalSupply)")}</dt>
          <dd>{c?.main != null ? num(c.main, 0) : "…"}</dd>
          <dd className={dd}>
            {match == null ? null : match ? (
              <Pill tone="up">{L("cocok dengan API", "matches the API")}</Pill>
            ) : (
              <Pill tone="neutral">
                {L("chain", "chain")} {c!.main! > a!.monTotal! ? "+" : "−"}
                {num(Math.abs(c!.main! - a!.monTotal!), 0)} {L("vs API (API di-cache)", "vs API (API is cached)")}
              </Pill>
            )}
          </dd>
        </div>
        <div>
          <dt className={dd}>{L("Semua chain", "All chains")}</dt>
          <dd>{a?.total != null ? num(a.total, 0, true) : "…"}</dd>
          {a && a.rank > 0 && a.monTotal != null && a.total ? (
            <dd className={dd}>
              Monad #{a.rank} {L("dari", "of")} {a.chains} · {pct((a.monTotal / a.total) * 100, 1)}
            </dd>
          ) : null}
        </div>
        <div>
          <dt className={dd}>{L("Testnet (kolateral Perpl)", "Testnet (Perpl collateral)")}</dt>
          <dd>{c?.test != null ? num(c.test, 0, true) : "…"}</dd>
          <dd className={dd}>
            <a className={link} href={explorerAddr(testAusd, copasChain.id)} target="_blank" rel="noreferrer">{testAusd.slice(0, 10)}…</a>
            {c?.sameCode ? ` · ${L("bytecode = mainnet", "same bytecode as mainnet")}` : ""}
          </dd>
        </div>
      </dl>

      <h3 className="micro mt-4 text-ink-3">{L("Cadangan", "Reserves")}</h3>
      <p className="num mt-1 text-sm" data-testid="ausd-attest">
        {num(ATTEST.reserves, 0)} {L("aset vs", "in assets vs")} {num(ATTEST.circulating, 0)} AUSD {L("beredar", "circulating")} · <span className="text-up">{pct(cover, 2)}</span>
      </p>
      <p className={dd}>
        {L(`Atestasi Grant Thornton LLP per ${ATTEST.asOf} (AICPA, ditandatangani ${ATTEST.signed}): T-bill AS, repo, dan kas.`, `Grant Thornton LLP attestation as of ${ATTEST.asOf} (AICPA standards, signed ${ATTEST.signed}): US T-bills, repo and cash.`)}{" "}
        <a className={link} href={ATTEST.pdf} target="_blank" rel="noreferrer">{L("Laporan PDF", "Report PDF")}</a> ·{" "}
        <a className={link} href="https://docs.agora.finance/developer/transparency" target="_blank" rel="noreferrer">{L("semua laporan", "all reports")}</a>
      </p>

      <h3 className="micro mt-4 text-ink-3">{L("Peg di Monad", "Peg on Monad")}</h3>
      <dl className="num mt-2 grid grid-cols-2 gap-3 text-sm" data-testid="ausd-peg">
        <div>
          <dt className={dd}>{L("Harga Instant Settlement", "Instant Settlement price")}</dt>
          <dd>{c?.price != null ? `${c.price.toFixed(6)} USDC` : "…"}</dd>
          {c?.feeBps && <dd className={dd}>{L("fee", "fee")} {num(c.feeBps[0], 2)} / {num(c.feeBps[1], 2)} bps{c.pairPaused ? ` · ${L("dijeda", "paused")}` : ""}</dd>}
        </div>
        <div>
          <dt className={dd}>{L("Likuiditas pair", "Pair liquidity")}</dt>
          <dd>{c?.ausdRes != null ? `${num(c.ausdRes, 0, true)} AUSD` : "…"}</dd>
          {c?.usdcRes != null && <dd className={dd}>{num(c.usdcRes, 0, true)} USDC</dd>}
        </div>
      </dl>
      <p className={`${dd} mt-2`}>
        {L(
          "Pair AUSD/USDC Agora menukar pada harga tetap untuk pengguna terverifikasi (role APPROVED_SWAPPER), jalur mint/redeem di Monad. Token: ",
          "Agora's AUSD/USDC pair swaps at a fixed price for verified users (APPROVED_SWAPPER role), the mint/redeem rail on Monad. Token: ",
        )}
        {c?.paused ? (
          <span data-testid="ausd-controls">
            mint {c.paused.mint ? L("dijeda", "paused") : "on"} · transfer {c.paused.xfer ? L("dijeda", "paused") : "on"} · burn {c.paused.burn ? L("dijeda", "paused") : "on"}
          </span>
        ) : (
          "…"
        )}{" "}
        ·{" "}
        <a className={link} href={explorerAddr(PAIR, monad.id)} target="_blank" rel="noreferrer">pair</a> ·{" "}
        <a className={link} href={explorerAddr(mainAusd, monad.id)} target="_blank" rel="noreferrer">AUSD</a>
      </p>
    </Panel>
  );
}
