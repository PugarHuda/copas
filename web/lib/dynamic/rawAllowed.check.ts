// npx tsx --conditions react-server lib/dynamic/rawAllowed.check.ts   (reads testnet)
import assert from "node:assert/strict";
import { encodeFunctionData, type Abi } from "viem";
import { copasAbi } from "../copas/contracts";
import { rawAllowed } from "./server";

const owner = { address: "0x7a9a8212d6baAD1C813B06fDe7c09de97b1760Cf" as const }; // owns demo vault 0xF427…
const vault = "0xF427C3Bd1C43f2AAc70d40f9021D9432D547DB41" as const;
const V = copasAbi.FollowerVault as Abi;
const unfollow = encodeFunctionData({ abi: V, functionName: "unfollow" });
const withdraw = encodeFunctionData({ abi: V, functionName: "withdraw", args: [1n] });
void (async () => {
  const ok = { chainId: 10143, to: vault, data: unfollow };
  assert.equal(await rawAllowed(owner, ok), null);
  assert.match((await rawAllowed(owner, { ...ok, data: withdraw }))!, /only vault.unfollow/);
  assert.match((await rawAllowed(owner, { ...ok, chainId: 143 }))!, /wrong chain/);
  assert.match((await rawAllowed(owner, { ...ok, value: 1n }))!, /value/);
  assert.match((await rawAllowed({ address: "0x57A9fCEEdeB87A0561481Dd24E0489bFECb96523" }, ok))!, /not owned/);
  assert.match((await rawAllowed(owner, { ...ok, to: "0x8478000000000000000000000000000000002a18" }))!, /not a Copas vault/);
  console.log("rawAllowed.check: ok");
})();
