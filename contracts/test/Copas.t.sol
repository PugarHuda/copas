// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry, ILeaderFactory, IVaultFactory} from "../src/CopasRegistry.sol";
import {LeaderFactory, VaultFactory} from "../src/Factories.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {UnderwriterPool} from "../src/UnderwriterPool.sol";
import {Mandate, FollowParams, LeaderStatus, BreachReason, CopasErrors} from "../src/CopasTypes.sol";
import {MockPerpl, MockAUSD} from "./mocks/MockPerpl.sol";

contract CopasBase is Test {
    uint256 constant BTC = 1;
    uint256 constant ETH = 20;
    uint256 constant SOL = 31;
    uint256 constant BTC_MARK = 850000; // $85,000.0 (1 price decimal)

    MockAUSD ausd;
    MockPerpl perpl;
    CopasRegistry reg;

    address alice = makeAddr("alice"); // leader
    address bob = makeAddr("bob"); // follower
    address carol = makeAddr("carol"); // follower
    address uw = makeAddr("underwriter");
    address reserve = makeAddr("reserve");
    address keeper = makeAddr("keeper");

    function setUp() public virtual {
        ausd = new MockAUSD();
        perpl = new MockPerpl(ausd);
        perpl.setMarket(BTC, BTC_MARK, 1, 5);
        perpl.setMarket(ETH, 30000, 2, 3); // $300.00
        perpl.setMarket(SOL, 150000, 3, 3); // $150.000
        reg = new CopasRegistry(IPerplExchange(address(perpl)), IERC20Min(address(ausd)), reserve);
        reg.setFactories(ILeaderFactory(address(new LeaderFactory(reg))), IVaultFactory(address(new VaultFactory(reg))));
        reg.addMarket(uint32(BTC), 1, 5); // index 0
        reg.addMarket(uint32(ETH), 2, 3); // index 1
        reg.addMarket(uint32(SOL), 3, 3); // index 2
        reg.setParams(10_000e6, 25e6, 1_000, 3, 1_000, 3_000, 1 hours);
        for (uint256 i; i < 5; i++) {
            address a = [alice, bob, carol, uw, keeper][i];
            ausd.mint(a, 1_000_000e6);
        }
    }

    function _mandate() internal pure returns (Mandate memory m) {
        m.maxDDbps = 1_000; // 10%
        m.maxLeverageHdths = 500; // 5x
        m.feeBps = 2_000; // 20%
        m.epochLen = 1 hours;
        m.maxNotionalCNS = 20_000e6;
        m.marketsMask = 0x3; // BTC, ETH
    }

    function _params(uint128 cap) internal pure returns (FollowParams memory p) {
        p.ratioBps = 5_000; // 50%
        p.maxLeverageHdths = 500;
        p.maxChaseBps = 200;
        p.priceBandBps = 50;
        p.stopLossBps = 0;
        p.maxNotionalCNS = cap;
        p.marketsMask = 0x3;
    }

    function _leader(uint256 capital, uint256 bondAmt) internal returns (LeaderBook lb) {
        vm.startPrank(alice);
        (address a,) = reg.createLeader(_mandate());
        lb = LeaderBook(a);
        ausd.approve(a, type(uint256).max);
        lb.deposit(capital);
        lb.postBond(bondAmt);
        lb.start();
        vm.stopPrank();
    }

    function _vault(address who, LeaderBook lb, uint256 amt, uint128 cap) internal returns (FollowerVault v) {
        vm.startPrank(who);
        v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(amt);
        v.follow(lb, _params(cap));
        vm.stopPrank();
    }

    function _roll(LeaderBook lb) internal {
        vm.warp(block.timestamp + 1 hours + 1);
        lb.rollEpoch();
    }

    function _lot(uint256 perpId, uint256 acct) internal view returns (int256) {
        (IPerplExchange.PositionInfo memory p,,) = perpl.getPosition(perpId, acct);
        return p.positionType == 0 ? int256(p.lotLNS) : -int256(p.lotLNS);
    }

    function _leaderLong(LeaderBook lb, uint256 lot) internal {
        vm.prank(alice);
        lb.trade(BTC, 0, lot, BTC_MARK * 101 / 100, 300);
    }
}

contract CopasTest is CopasBase {
    function test_leaderStartsActiveAndDepositKeepsUnitPrice() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        assertEq(uint256(lb.status()), uint256(LeaderStatus.Active));
        assertEq(lb.epoch(), 1);
        _leaderLong(lb, 1_000); // 0.01 BTC
        perpl.setMark(BTC, BTC_MARK * 105 / 100);
        (uint256 u0,) = lb.unitPrice();
        vm.prank(alice);
        lb.deposit(500e6);
        (uint256 u1,) = lb.unitPrice();
        assertApproxEqRel(u1, u0, 1e12, "deposit moved unit price");
    }

    function test_tradeOutsideMandateReverts() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(CopasErrors.MarketNotAllowed.selector);
        lb.trade(SOL, 0, 1_000, 200000, 200);
        vm.expectRevert(abi.encodeWithSelector(CopasErrors.MandateViolation.selector, BreachReason.Leverage));
        lb.trade(BTC, 0, 100, BTC_MARK * 101 / 100, 600);
        vm.expectRevert(abi.encodeWithSelector(CopasErrors.MandateViolation.selector, BreachReason.Notional));
        lb.trade(BTC, 0, 30_000, BTC_MARK * 101 / 100, 500); // 0.3 BTC = $25.5k > 20k
        vm.stopPrank();
    }

    function test_syncCopiesRatioAndFollowsClose_permissionless() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _leaderLong(lb, 1_000);

        vm.prank(keeper);
        int256 t = v.sync(BTC);
        assertEq(t, 500);
        assertEq(_lot(BTC, v.accountId()), 500);

        // leader halves -> follower halves
        vm.prank(alice);
        lb.trade(BTC, 2, 500, BTC_MARK * 99 / 100, 100);
        vm.prank(carol); // a stranger can only push toward target
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 250);

        // leader closes -> follower closes
        vm.prank(alice);
        lb.trade(BTC, 2, 500, BTC_MARK * 99 / 100, 100);
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 0);
    }

    function test_syncRespectsFollowerNotionalCap() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 100e6); // cap $100
        _leaderLong(lb, 1_000); // leader $850, ratio 50% wants $425
        v.sync(BTC);
        // $100 / $85,000 = 0.001176 BTC => 117 lots
        assertEq(_lot(BTC, v.accountId()), 117);
    }

    function test_syncSkipsWhenPriceChasedTooFar() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _leaderLong(lb, 1_000);
        perpl.setMark(BTC, BTC_MARK * 103 / 100); // +3% > 2% chase
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 0);
    }

    function test_drawdownBreachSlashesAndFollowerClaims() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _roll(lb); // bob becomes eligible from epoch 2
        v.touch();
        _leaderLong(lb, 1_000); // ~$850 notional on $1000
        v.sync(BTC);

        perpl.setMark(BTC, BTC_MARK * 85 / 100); // -15% => leader equity -12.75%
        lb.checkpoint();
        assertEq(uint256(lb.status()), uint256(LeaderStatus.Breached));
        LeaderBook.Breach memory b = lb.breachOf(2);
        assertEq(uint256(b.reason), uint256(BreachReason.Drawdown));
        assertEq(b.pot, 100e6);
        assertEq(lb.bond(), 0);

        // follower is unwound reduce-only
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 0);

        uint256 loss = v.lossIn(2);
        assertGt(loss, 0);
        uint256 before = ausd.balanceOf(bob);
        v.claim(lb, 2);
        uint256 got = ausd.balanceOf(bob) - before;
        assertEq(got, loss < 100e6 ? loss : 100e6, "claim = min(share, loss)");

        vm.expectRevert(CopasErrors.AlreadyClaimed.selector);
        v.claim(lb, 2);
    }

    function test_followerJoiningMidEpochNotEligible() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        _roll(lb);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6); // joins during epoch 2 -> eligible from 3
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 85 / 100);
        lb.checkpoint();
        assertTrue(lb.breached(2));
        vm.expectRevert(CopasErrors.NotVault.selector);
        v.claim(lb, 2);
    }

    function test_proRataBetweenFollowers() public {
        LeaderBook lb = _leader(2_000e6, 400e6);
        FollowerVault vb = _vault(bob, lb, 1_000e6, 3_000e6);
        FollowerVault vc = _vault(carol, lb, 1_000e6, 1_000e6);
        _roll(lb);
        vb.touch();
        vc.touch();
        _leaderLong(lb, 2_000); // $1700
        vb.sync(BTC);
        vc.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 80 / 100);
        lb.checkpoint();
        uint256 b0 = ausd.balanceOf(bob);
        uint256 c0 = ausd.balanceOf(carol);
        vb.claim(lb, 2);
        vc.claim(lb, 2);
        uint256 gb = ausd.balanceOf(bob) - b0;
        uint256 gc = ausd.balanceOf(carol) - c0;
        assertLe(gb, 300e6); // 3/4 of pot
        assertLe(gc, 100e6); // 1/4 of pot
        LeaderBook.Breach memory br = lb.breachOf(2);
        assertLe(br.claimed, br.pot);
    }

    function test_underwriterSlashedAfterBondAndEarnsFees() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        UnderwriterPool pool = lb.pool();
        vm.startPrank(uw);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(200e6);
        vm.stopPrank();
        assertEq(lb.protection(), 300e6);

        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _roll(lb);
        v.touch();
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 85 / 100);
        lb.checkpoint();
        assertEq(lb.breachOf(2).pot, 300e6);
        assertEq(pool.assets(), 0);
    }

    function test_feeEscrowReleasedWithoutBreach() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _roll(lb);
        v.touch();
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 105 / 100); // profit
        // close both to free balance
        vm.prank(alice);
        lb.trade(BTC, 2, 1_000, BTC_MARK * 104 / 100, 100);
        v.sync(BTC);
        _roll(lb); // epoch 3
        v.touch(); // fee charged on epoch 2 profit -> leader escrow
        assertGt(lb.feeEscrow(), 0);
        uint256 esc = lb.feeEscrow();
        _roll(lb); // epoch 3 ends without breach -> released
        assertEq(lb.feeEscrow(), 0);
        assertEq(lb.feeClaimable(), esc);
    }

    function test_referrerEarnsShareOfProtocolFee() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        address ref = makeAddr("ref");
        vm.startPrank(bob);
        FollowerVault v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(500e6);
        v.setReferrer(ref);
        v.follow(lb, _params(1_000e6));
        vm.stopPrank();
        _roll(lb);
        v.touch();
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 105 / 100);
        vm.prank(alice);
        lb.trade(BTC, 2, 1_000, BTC_MARK * 104 / 100, 100);
        v.sync(BTC);
        _roll(lb);
        v.touch();
        assertGt(ausd.balanceOf(ref), 0, "referrer unpaid");
        assertGt(ausd.balanceOf(reserve), 0, "reserve unpaid");
        vm.prank(bob);
        vm.expectRevert(CopasErrors.BadParams.selector);
        v.setReferrer(carol);
    }

    function test_unbondOnlyAfterDelay() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        vm.prank(alice);
        lb.requestUnbond(60e6); // unlock at epoch 1+1+1 = 3
        _roll(lb); // -> epoch 2: still bonded
        assertEq(lb.bond(), 100e6);
        _roll(lb); // -> epoch 3: released
        assertEq(lb.bond(), 40e6);
        assertEq(uint256(lb.status()), uint256(LeaderStatus.Active)); // 40 >= 25 min
    }

    function test_capacityLimitsFollowers() public {
        LeaderBook lb = _leader(100e6, 30e6); // cap = min(3*100, 30/10%) = 300
        vm.startPrank(bob);
        FollowerVault v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(100e6);
        vm.expectRevert(CopasErrors.CapacityExceeded.selector);
        v.follow(lb, _params(400e6));
        vm.stopPrank();
    }

    function test_stopLossPausesCopy() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        vm.startPrank(bob);
        FollowerVault v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(100e6);
        FollowParams memory p = _params(500e6);
        p.ratioBps = 20_000; // aggressive 2x
        p.stopLossBps = 500; // 5%
        v.follow(lb, p);
        vm.stopPrank();
        _leaderLong(lb, 500);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 92 / 100);
        v.sync(BTC); // trips stop-loss -> target 0 -> closes
        assertTrue(v.paused());
        assertEq(_lot(BTC, v.accountId()), 0);
    }

    function test_onlyOwnerWithdrawsToOwner() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 200e6, 500e6);
        vm.prank(carol);
        vm.expectRevert(CopasErrors.NotOwner.selector);
        v.withdraw(10e6);
        uint256 b0 = ausd.balanceOf(bob);
        vm.prank(bob);
        v.withdraw(10e6);
        assertEq(ausd.balanceOf(bob) - b0, 10e6);
    }

    function test_invalidMarkSkipsCheckpoint() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        _leaderLong(lb, 1_000);
        perpl.setMark(BTC, BTC_MARK * 50 / 100);
        perpl.setMarkInvalid(BTC, true);
        lb.checkpoint();
        assertEq(uint256(lb.status()), uint256(LeaderStatus.Active));
    }
}
