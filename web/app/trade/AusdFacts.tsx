"use client";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, erc20Abi } from "viem";
import { Panel, Source } from "@/components/ui";
import { PERPL, copasChain, explorerAddr, monad, rpcTransport } from "@/lib/chains";
import { copasPublic } from "@/lib/copas/useCopasWrite";
import { num } from "@/lib/format";

const mainnet = createPublicClient({ chain: monad, transport: rpcTransport(monad) });

/** AUSD facts read onchain: the token this app margins with (testnet) and Agora's AUSD on Monad mainnet. */
export function AusdFacts() {
  const testAusd = PERPL[copasChain.id as keyof typeof PERPL].ausd as `0x${string}`;
  const mainAusd = PERPL[monad.id].ausd as `0x${string}`;
  const q = useQuery({
    queryKey: ["ausd-facts"],
    staleTime: 60_000,
    queryFn: async () => {
      const [main, test] = await Promise.all([
        mainnet.readContract({ address: mainAusd, abi: erc20Abi, functionName: "totalSupply" }).catch(() => null),
        copasPublic.readContract({ address: testAusd, abi: erc20Abi, functionName: "totalSupply" }).catch(() => null),
      ]);
      return { main: main == null ? null : Number(main) / 1e6, test: test == null ? null : Number(test) / 1e6 };
    },
  });
  return (
    <Panel title="AUSD" aside={<Source kind="rpc">totalSupply()</Source>}>
      <p className="text-sm text-ink-2">
        Agora&apos;s dollar is the only collateral Perpl takes, so your margin, PnL and any Copas bond are all AUSD.
      </p>
      <dl className="num mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-3">AUSD supply on Monad mainnet</dt>
          <dd>{q.data?.main != null ? num(q.data.main, 0, true) : "…"}</dd>
          <dd className="text-xs">
            <a className="underline text-ink-3" href={explorerAddr(mainAusd, monad.id)} target="_blank" rel="noreferrer">{mainAusd.slice(0, 10)}…</a>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Perpl testnet AUSD supply</dt>
          <dd>{q.data?.test != null ? num(q.data.test, 0, true) : "…"}</dd>
          <dd className="text-xs">
            <a className="underline text-ink-3" href={explorerAddr(testAusd, copasChain.id)} target="_blank" rel="noreferrer">{testAusd.slice(0, 10)}…</a>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
