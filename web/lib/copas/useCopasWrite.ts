"use client";
import { useCallback, useState } from "react";
import { createPublicClient, createWalletClient, type Abi } from "viem";
import { copasChain, rpcTransport } from "../chains";
import { toUiError, useMeraSession, type ActionRisk } from "../mera/MeraProvider";
import { isDeployed } from "./contracts";

export const copasPublic = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });

type Call = { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] };

/**
 * Sends a Copas transaction signed by the Mera passkey account.
 * `risk` decides whether the live session may sign (small) or the passkey must be re-presented (risky). See SPEC E2.
 */
export function useCopasWrite() {
  const { authorize } = useMeraSession();
  const [pending, setPending] = useState(false);
  const [hash, setHash] = useState<`0x${string}`>();
  const [error, setError] = useState<string>();

  const write = useCallback(
    async (risk: ActionRisk, call: Call) => {
      setError(undefined);
      if (!isDeployed) {
        setError("contracts-not-deployed");
        return;
      }
      setPending(true);
      try {
        const account = await authorize(risk);
        const wallet = createWalletClient({ account, chain: copasChain, transport: rpcTransport(copasChain) });
        const h = await wallet.writeContract({ ...call, args: call.args ?? [] } as never);
        setHash(h);
        if ((await copasPublic.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error(`transaction reverted: ${h}`);
        return h;
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        setError(code === "TIMEOUT" || code === "CANCELLED" ? toUiError(e).message.en : e instanceof Error ? e.message.split("\n")[0] : String(e));
      } finally {
        setPending(false);
      }
    },
    [authorize],
  );

  return { write, pending, hash, error };
}
