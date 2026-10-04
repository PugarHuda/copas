import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 143;
const T0 = 1_771_200_000 + 3_600; // 2026-02-16 01:00 UTC
const DAY = Math.floor(T0 / 86_400);
const BTC = 1n;
const PX_OPEN = 1_000_000n; // BTC has priceDecimals 1, lotDecimals 5
const PX_CLOSE = 1_100_000n;
const LOT = 10n; // 10 * 1e6 / 1e6 => 10 AUSD notional at PX_OPEN

const at = (block: number, ts: number, hash: string) => ({
  block: { number: block, timestamp: ts },
  transaction: { hash },
});

// A taker (account 7) opens a long against a maker (account 8), then both close an hour later.
const roundTrip = [
  { contract: "PerplExchange", event: "AccountCreated", ...at(60_000_000, T0, "0xa1"),
    params: { account: "0x00000000000000000000000000000000000000Aa", id: 7n } },
  { contract: "PerplExchange", event: "AccountCreated", ...at(60_000_000, T0, "0xa2"),
    params: { account: "0x00000000000000000000000000000000000000bB", id: 8n } },
  { contract: "PerplExchange", event: "CollateralDeposit", ...at(60_000_000, T0, "0xa3"),
    params: { accountId: 7n, amountCNS: 1_000_000_000n, balanceCNS: 1_000_000_000n } },
  // open: maker position + fill, then taker position + fill (Perpl's real ordering)
  { contract: "PerplExchange", event: "PositionOpenedV2", ...at(60_000_010, T0 + 100, "0xb1"),
    params: { perpId: BTC, accountId: 8n, positionType: 1n, leverageHdths: 500n, depositCNS: 2_000_000n,
      pnlCollateralizedCNS: 0n, pricePNS: PX_OPEN, lotLNS: LOT, insFeeCNS: 1n, protFeeCNS: 2n, priceResiduePNSQ16: 0n } },
  { contract: "PerplExchange", event: "MakerOrderFilledV2", ...at(60_000_010, T0 + 100, "0xb1"),
    params: { perpId: BTC, accountId: 8n, orderId: 1n, pricePNS: PX_OPEN, lotLNS: LOT, feeCNS: 3n,
      lockedBalanceCNS: 0n, amountCNS: -2_000_003n, balanceCNS: 5_000_000n, builderId: 0n, builderFeeCNS: 0n } },
  { contract: "PerplExchange", event: "PositionOpenedV2", ...at(60_000_010, T0 + 100, "0xb1"),
    params: { perpId: BTC, accountId: 7n, positionType: 0n, leverageHdths: 500n, depositCNS: 2_000_000n,
      pnlCollateralizedCNS: 0n, pricePNS: PX_OPEN, lotLNS: LOT, insFeeCNS: 2n, protFeeCNS: 3n, priceResiduePNSQ16: 0n } },
  { contract: "PerplExchange", event: "TakerOrderFilledV2", ...at(60_000_010, T0 + 100, "0xb1"),
    params: { entryPricePNS: PX_OPEN, collatPricePNS: PX_OPEN, pnlPricePNS: PX_OPEN, lotLNS: LOT, feeCNS: 5n,
      amountCNS: -2_000_005n, balanceCNS: 997_999_995n, builderId: 0n, builderFeeCNS: 0n } },
  // close one hour later (V1 fill events to cover the pre-upgrade topic0s)
  { contract: "PerplExchange", event: "PositionClosed", ...at(60_000_020, T0 + 3_700, "0xc1"),
    params: { perpId: BTC, accountId: 8n, positionType: 1n, pricePNS: PX_CLOSE, deltaPnlCNS: -1_000_000n, fundingCNS: 0n } },
  { contract: "PerplExchange", event: "MakerOrderFilled", ...at(60_000_020, T0 + 3_700, "0xc1"),
    params: { perpId: BTC, accountId: 8n, orderId: 2n, pricePNS: PX_CLOSE, lotLNS: LOT, feeCNS: 3n,
      lockedBalanceCNS: 0n, amountCNS: 999_997n, balanceCNS: 5_999_997n } },
  { contract: "PerplExchange", event: "PositionClosed", ...at(60_000_020, T0 + 3_700, "0xc1"),
    params: { perpId: BTC, accountId: 7n, positionType: 0n, pricePNS: PX_CLOSE, deltaPnlCNS: 1_000_000n, fundingCNS: -10_000n } },
  { contract: "PerplExchange", event: "TakerOrderFilled", ...at(60_000_020, T0 + 3_700, "0xc1"),
    params: { entryPricePNS: PX_CLOSE, collatPricePNS: PX_CLOSE, pnlPricePNS: PX_CLOSE, lotLNS: LOT, feeCNS: 5n,
      amountCNS: 2_989_995n, balanceCNS: 1_000_989_990n } },
] as const;

describe("Perpl Exchange", () => {
  it("fills update Account volume and Trade; closes create ClosedTrade; daily aggregates update", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [...roundTrip] } } });

    // fill -> Account volume + Trade (taker resolved from the same tx)
    const taker = await indexer.Account.getOrThrow("7");
    expect(taker.address).toBe("0x00000000000000000000000000000000000000aa");
    expect(taker.takerFills).toBe(2);
    expect(taker.volumeCNS).toBe(10_000_000n + 11_000_000n);
    expect(taker.feesCNS).toBe(10n);
    expect(taker.realizedPnlCNS).toBe(990_000n);
    expect(taker.netPnlCNS).toBe(989_990n);
    expect(taker.depositsCNS).toBe(1_000_000_000n);
    expect([taker.closedTrades, taker.wins, taker.losses, taker.currentStreak]).toEqual([1, 1, 0, 1]);

    const trades = await indexer.Trade.getAll();
    expect(trades).toHaveLength(2);
    const openTrade = trades.find((t) => t.txHash === "0xb1")!;
    expect(openTrade).toMatchObject({ maker_id: "8", taker_id: "7", takerSide: "BUY", notionalCNS: 10_000_000n });
    expect(trades.find((t) => t.txHash === "0xc1")).toMatchObject({ taker_id: "7", takerSide: "SELL" });

    const fills = await indexer.Fill.getAll();
    expect(fills).toHaveLength(4);
    expect(fills.filter((f) => f.version === 1)).toHaveLength(2);
    expect(fills.find((f) => f.txHash === "0xc1" && f.role === "TAKER")).toMatchObject({
      account_id: "7", market_id: "1", side: "SELL", realizedPnlCNS: 990_000n,
    });

    // close -> ClosedTrade with pnl, fees from both fills, hold time
    const won = await indexer.ClosedTrade.getOrThrow("7-1-1");
    expect(won).toMatchObject({
      side: "LONG", reason: "CLOSED", entryPricePNS: PX_OPEN, exitPricePNS: PX_CLOSE, maxLotLNS: LOT,
      pnlCNS: 990_000n, fundingCNS: -10_000n, feesCNS: 10n, netPnlCNS: 989_990n, isWin: true, holdSeconds: 3_600,
      openTx: "0xb1", closeTx: "0xc1",
    });
    const lost = await indexer.ClosedTrade.getOrThrow("8-1-1");
    expect(lost).toMatchObject({ side: "SHORT", pnlCNS: -1_000_000n, feesCNS: 6n, netPnlCNS: -1_000_006n, isWin: false });
    const maker = await indexer.Account.getOrThrow("8");
    expect([maker.losses, maker.currentStreak, maker.maxDrawdownCNS]).toEqual([1, -1, 1_000_006n]);

    const pos = await indexer.Position.getOrThrow("7-1");
    expect([pos.isOpen, pos.lotLNS, pos.lastClosedTrade_id]).toEqual([false, 0n, "7-1-1"]);

    // daily aggregates
    const pd = await indexer.ProtocolDaily.getOrThrow(String(DAY));
    expect(pd).toMatchObject({
      volumeCNS: 21_000_000n, longVolumeCNS: 10_000_000n, shortVolumeCNS: 11_000_000n, feesCNS: 16n, trades: 2,
      uniqueTraders: 2, newAccounts: 2, depositsCNS: 1_000_000_000n, netFlowCNS: 1_000_000_000n,
      realizedPnlCNS: -10_000n, openInterestCNS: 0n,
    });
    const md = await indexer.MarketDaily.getOrThrow(`1-${DAY}`);
    expect(md).toMatchObject({
      volumeCNS: 21_000_000n, trades: 2, uniqueTraders: 2, openPricePNS: PX_OPEN, highPricePNS: PX_CLOSE,
      lowPricePNS: PX_OPEN, closePricePNS: PX_CLOSE, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n,
    });
    const ad = await indexer.AccountDaily.getOrThrow(`7-${DAY}`);
    expect([ad.fills, ad.volumeCNS, ad.cumNetPnlCNS]).toEqual([2, 21_000_000n, 989_990n]);
    const proto = await indexer.Protocol.getOrThrow("perpl");
    expect([proto.accounts, proto.traders, proto.volumeCNS, proto.openInterestCNS]).toEqual([2, 2, 21_000_000n, 0n]);
  });

  it("tracks open interest while a position is open", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: roundTrip.slice(0, 7) } } });
    const m = await indexer.Market.getOrThrow("1");
    expect([m.symbol, m.longOpenInterestLNS, m.shortOpenInterestLNS, m.openInterestCNS]).toEqual(["BTC", LOT, LOT, 10_000_000n]);
    const acc = await indexer.Account.getOrThrow("7");
    expect(acc.openPositions).toBe(1);
  });

  it("liquidation records Liquidation, closes the trade and funding events land on the market", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...roundTrip.slice(3, 7),
            { contract: "PerplExchange", event: "PositionLiquidated", ...at(60_000_030, T0 + 7_300, "0xd1"),
              params: { perpId: BTC, posAccountId: 7n, positionType: 0n, markPricePNS: 900_000n, liqPricePNS: 905_000n,
                liqLotLNS: LOT, posLotLNS: LOT, deltaPnlCNS: -950_000n, fundingCNS: -5_000n, posAmountCNS: 0n,
                posDepositCNS: 0n, accAmountCNS: 0n, accBalanceCNS: 0n, onOrderBook: false } },
            { contract: "PerplExchange", event: "FundingEventCompleted", ...at(60_000_040, T0 + 7_400, "0xe1"),
              params: { perpId: BTC, fundingEventBlock: 60_000_040n, specifiedRatePct100k: 12n, actualRatePct100k: 10n,
                fundingPricePNS: 900_000n, fundingPaymentPNS: 3n, fundingSumPNS: 42n, allowOverwrite: false } },
          ],
        },
      },
    });
    const liqs = await indexer.Liquidation.getAll();
    expect(liqs).toHaveLength(1);
    expect(liqs[0]).toMatchObject({ account_id: "7", kind: "LIQUIDATED", side: "LONG", notionalCNS: 9_000_000n });
    // forced close: booked immediately (no closing fill)
    const ct = await indexer.ClosedTrade.getOrThrow("7-1-1");
    expect(ct).toMatchObject({ reason: "LIQUIDATED", exitPricePNS: 905_000n, pnlCNS: -955_000n, feesCNS: 5n, isWin: false });
    const acc = await indexer.Account.getOrThrow("7");
    expect([acc.liquidations, acc.losses, acc.openPositions]).toEqual([1, 1, 0]);
    const m = await indexer.Market.getOrThrow("1");
    expect([m.liquidations, m.lastFundingRatePct100k, m.longOpenInterestLNS]).toEqual([1, 10n, 0n]);
    expect(await indexer.FundingEvent.getAll()).toHaveLength(1);
  });
});
