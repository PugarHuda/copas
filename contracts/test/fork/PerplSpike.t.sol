// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {IPerplExchange, IERC20Min} from "../../src/interfaces/IPerplExchange.sol";

/// @dev Throwaway contract that owns a Perpl account, to prove contract-held accounts can trade.
contract SpikeHolder {
    IPerplExchange public immutable ex;
    IERC20Min public immutable ausd;
    uint256 public accountId;

    constructor(IPerplExchange _ex, IERC20Min _ausd) {
        ex = _ex;
        ausd = _ausd;
    }

    function open(uint256 amt) external {
        ausd.approve(address(ex), type(uint256).max);
        accountId = ex.createAccount(amt);
    }

    function order(IPerplExchange.OrderDesc calldata o) external returns (IPerplExchange.OrderSignature memory) {
        return ex.execOrder(o);
    }
}

/// Run: forge test --match-contract PerplSpike --fork-url $MONAD_RPC_URL -vv
contract PerplSpikeTest is Test {
    IPerplExchange constant EX = IPerplExchange(0x34B6552d57a35a1D042CcAe1951BD1C370112a6F);
    IERC20Min constant AUSD = IERC20Min(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
    uint256 constant BTC = 1;

    SpikeHolder holder;

    function setUp() public {
        holder = new SpikeHolder(EX, AUSD);
    }

    /// AUSD packs {uint8 flags; uint248 balance} in one slot.
    function _deal(address to, uint256 amount) internal {
        vm.record();
        AUSD.balanceOf(to);
        (bytes32[] memory reads,) = vm.accesses(address(AUSD));
        bytes32 slot = reads[reads.length - 1];
        uint256 cur = uint256(vm.load(address(AUSD), slot));
        vm.store(address(AUSD), slot, bytes32((amount << 8) | (cur & 0xff)));
        require(AUSD.balanceOf(to) == amount, "AUSD layout");
    }

    function _equity(uint256 acct) internal view returns (int256 eq, bool valid) {
        IPerplExchange.AccountInfo memory a = EX.getAccountById(acct);
        eq = int256(a.balanceCNS);
        valid = true;
        uint256[4] memory perps = [uint256(1), 10, 20, 31];
        for (uint256 i; i < 4; i++) {
            (IPerplExchange.PositionInfo memory p,, bool ok) = EX.getPosition(perps[i], acct);
            if (p.lotLNS == 0) continue;
            if (!ok) valid = false;
            eq += int256(p.depositCNS) + p.pnlCNS;
        }
    }

    function _ioc(uint8 orderType, uint256 price, uint256 lot) internal view returns (IPerplExchange.OrderDesc memory) {
        return IPerplExchange.OrderDesc({
            orderDescId: 0,
            perpId: BTC,
            orderType: orderType,
            orderId: 0,
            pricePNS: price,
            lotLNS: lot,
            expiryBlock: block.number + 100,
            postOnly: false,
            fillOrKill: false,
            immediateOrCancel: true,
            maxMatches: 0,
            leverageHdths: 200,
            lastExecutionBlock: 0,
            amountCNS: 0,
            maxNegPnlCollatBPS: 0
        });
    }

    function test_contractCanOpenAccountTradeAndReadEquity() public {
        assertFalse(EX.whitelistingEnabled(), "whitelisting on");

        _deal(address(holder), 50e6);
        holder.open(50e6);
        uint256 acct = holder.accountId();
        assertGt(acct, 0, "no account");
        assertEq(EX.getAccountById(acct).accountAddr, address(holder), "owner != contract");

        IPerplExchange.PerpetualInfo memory info = EX.getPerpetualInfo(BTC);
        uint256 bestAsk = info.basePricePNS + info.minAskPriceONS;
        uint256 bestBid = info.basePricePNS + info.maxBidPriceONS;
        emit log_named_uint("mark", info.markPNS);
        emit log_named_uint("bestBid", bestBid);
        emit log_named_uint("bestAsk", bestAsk);
        emit log_named_uint("markTs", info.markTimestamp);
        emit log_named_uint("now", block.timestamp);

        // Buy 0.0001 BTC (lot 10, 5 lot decimals) crossing the ask by 1%.
        holder.order(_ioc(0, bestAsk * 101 / 100, 10));
        (IPerplExchange.PositionInfo memory pos,, bool valid) = EX.getPosition(BTC, acct);
        emit log_named_uint("lot after open", pos.lotLNS);
        emit log_named_uint("entry", pos.pricePNS);
        assertEq(pos.lotLNS, 10, "not filled");
        assertTrue(valid, "mark invalid");

        (int256 eq, bool ok) = _equity(acct);
        emit log_named_int("equity CNS", eq);
        assertTrue(ok);
        assertGt(eq, 45e6, "equity too low");

        // Close with IOC sell crossing the bid by 1%.
        holder.order(_ioc(2, bestBid * 99 / 100, 10));
        (pos,,) = EX.getPosition(BTC, acct);
        assertEq(pos.lotLNS, 0, "not closed");
        (eq,) = _equity(acct);
        emit log_named_int("equity after close", eq);
    }
}
