import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

const T = 1_780_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const LB = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const VAULT = "0x4444444444444444444444444444444444444444";
const at = (n: number, hash: string) => ({ block: { number: 60_000_000 + n, timestamp: T + n }, transaction: { hash } });

describe("Copas", () => {
  it("registers LeaderBook/Vault from the registry and tracks bond, follows, breach, claims", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "CopasRegistry", event: "LeaderCreated", ...at(100, "0x01"), params: { owner: OWNER, leaderBook: LB, pool: POOL } },
            { contract: "CopasRegistry", event: "VaultCreated", ...at(100, "0x02"), params: { owner: OWNER, vault: VAULT } },
            { contract: "PerplExchange", event: "AccountCreated", ...at(101, "0x03"), params: { account: LB, id: 900n } },
            { contract: "LeaderBook", event: "BondPosted", srcAddress: LB, ...at(102, "0x04"), params: { amount: 500_000_000n, bond: 500_000_000n } },
            { contract: "FollowerVault", event: "Followed", srcAddress: VAULT, ...at(103, "0x05"),
              params: { leader: LB, p: { ratioBps: 5_000n, maxLeverageHdths: 300n, maxChaseBps: 50n, priceBandBps: 30n,
                stopLossBps: 2_000n, maxNotionalCNS: 1_000_000_000n, marketsMask: 3n } } },
            { contract: "LeaderBook", event: "FollowerRegistered", srcAddress: LB, ...at(103, "0x05"), params: { vault: VAULT, cap: 1_000_000_000n, fromEpoch: 1n } },
            { contract: "FollowerVault", event: "Synced", srcAddress: VAULT, ...at(104, "0x06"),
              params: { perpId: 1n, leaderLot: 10n, fromLot: 0n, targetLot: 5n, mark: 1_000_000n } },
            { contract: "LeaderBook", event: "Checkpoint", srcAddress: LB, ...at(105, "0x07"),
              params: { epoch: 1n, equity: 900_000_000n, unitPrice: 900_000n, peak: 1_000_000_000n, ddBps: 1_000n, leverageHdths: 200n } },
            { contract: "LeaderBook", event: "Breached", srcAddress: LB, ...at(105, "0x07"), params: { epoch: 1n, reason: 1n, pot: 200_000_000n, capTotal: 1_000_000_000n } },
            { contract: "LeaderBook", event: "Claimed", srcAddress: LB, ...at(106, "0x08"), params: { epoch: 1n, vault: VAULT, to: VAULT, amount: 150_000_000n } },
          ],
        },
      },
    });

    const lb = LB.toLowerCase();
    const leader = await indexer.Leader.getOrThrow(lb);
    expect(leader).toMatchObject({
      owner: OWNER, underwriterPool: POOL, perplAccount_id: "900", bondCNS: 500_000_000n, status: "Breached",
      followers: 1, maxDrawdownBps: 1_000, totalSlashedCNS: 200_000_000n, currentEpoch: 1,
    });
    expect(await indexer.Follower.getOrThrow(`${VAULT}-${lb}`)).toMatchObject({ active: true, ratioBps: 5_000, capCNS: 1_000_000_000n });
    expect(await indexer.Vault.getOrThrow(VAULT)).toMatchObject({ currentLeader_id: lb });
    const [copy] = await indexer.CopyFill.getAll();
    expect(copy).toMatchObject({ vault_id: VAULT, leader_id: lb, market_id: "1", targetLotLNS: 5n, txHash: "0x06" });
    expect(await indexer.Breach.getOrThrow(`${lb}-1`)).toMatchObject({ potCNS: 200_000_000n, claimedCNS: 150_000_000n });
    expect(await indexer.Claim.getAll()).toHaveLength(1);
  });
});
