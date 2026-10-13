// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {CopasBase} from "./Copas.t.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {UnderwriterPool} from "../src/UnderwriterPool.sol";
import {BreachMarket, BreachToken} from "../src/BreachMarket.sol";
import {MockAUSD} from "./mocks/MockPerpl.sol";
import {CopasErrors, Mandate} from "../src/CopasTypes.sol";

/// @dev Findings in contracts/SECURITY.md. `test_KNOWN_*` tests pin the behaviour of the DEPLOYED source
/// (the bug reproduces); the fix is in contracts/security-fixes.patch and flips each of them.
contract SecurityTest is CopasBase {
    /// S-1: a withdrawal after unfollow was not booked as a flow, so lossIn() counted it as a trading loss.
    /// Collusion: a leader's own (sybil) vault recovers the slashed pot, underwriter money included.
    function test_KNOWN_S1_withdrawAfterUnfollowInflatesLoss() public {
        UnderwriterPool pool;
        LeaderBook lb = _leader(1_000e6, 100e6);
        pool = lb.pool();
        vm.startPrank(uw);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(200e6);
        vm.stopPrank();
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6); // bob = the leader's sybil, the only follower
        _roll(lb);
        v.touch();
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 85 / 100);
        lb.checkpoint();
        v.sync(BTC); // unwound
        uint256 real = v.lossIn(2); // 63.75 AUSD

        vm.startPrank(bob);
        v.unfollow();
        (uint256 eq,) = v.equity();
        v.withdraw(eq);
        vm.stopPrank();
        assertEq(v.lossIn(2), 500e6, "withdrawal counted as loss");

        uint256 b0 = ausd.balanceOf(bob);
        v.claim(lb, 2);
        assertEq(ausd.balanceOf(bob) - b0, 300e6, "whole pot (bond + underwriters) instead of the real loss");
        assertGt(300e6, real);
    }

    /// S-2: per-epoch flow data is keyed by epoch number only, so a new leader's epoch e inherited the
    /// previous leader's netFlow[e].
    function test_KNOWN_S2_staleFlowFromPreviousLeader() public {
        LeaderBook a = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, a, 500e6, 1_000e6);
        _roll(a);
        v.touch(); // epoch 2 under A
        LeaderBook b = _leader(1_000e6, 100e6); // epoch 1
        vm.startPrank(bob);
        v.deposit(300e6); // netFlow[2] += 300 under A
        v.unfollow();
        v.follow(b, _params(1_000e6));
        vm.stopPrank();
        _roll(b);
        v.touch(); // epoch 2 under B, nothing traded
        assertEq(v.lossIn(2), 300e6, "A's deposit shows up as a loss under B");
    }

    /// S-3: after a breach drains the pool, old (worthless) shares diluted the next depositor.
    function test_KNOWN_S3_poolDepositAfterWipeIsDiluted() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        UnderwriterPool pool = lb.pool();
        vm.startPrank(uw);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(200e6);
        vm.stopPrank();
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _roll(lb);
        v.touch();
        _leaderLong(lb, 1_000);
        perpl.setMark(BTC, BTC_MARK * 85 / 100);
        lb.checkpoint();
        assertEq(pool.assets(), 0);

        vm.startPrank(carol);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(100e6);
        vm.stopPrank();
        assertEq(pool.valueOf(carol), 33_333_333, "2/3 of new money goes to wiped shares");
        assertEq(pool.valueOf(uw), 66_666_666);
    }

    /// S-3b: first-depositor donation attack. Attacker must not profit from a victim's rounding.
    function test_KNOWN_S3b_poolDonationAttack() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        UnderwriterPool pool = lb.pool();
        address attacker = makeAddr("attacker");
        ausd.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(1);
        ausd.transfer(address(pool), 100e6); // donation
        vm.stopPrank();

        vm.startPrank(carol);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(150e6);
        vm.stopPrank();
        assertEq(pool.valueOf(attacker), 125_000_000, "attacker takes 25 AUSD of the victim's deposit");
    }

    /// S-4: an unlocked underwriter request stayed valid forever, i.e. a free option to exit just
    /// before a breach while still earning fees.
    function test_KNOWN_S4_poolUnlockStaysOpen() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        UnderwriterPool pool = lb.pool();
        vm.startPrank(uw);
        ausd.approve(address(pool), type(uint256).max);
        pool.deposit(200e6);
        pool.requestWithdraw(200e6); // unlock at epoch 1 + 1 + 1 = 3
        vm.stopPrank();
        _roll(lb);
        _roll(lb);
        _roll(lb); // epoch 4: window missed
        vm.prank(uw);
        pool.withdraw(); // still possible any time later
        assertEq(pool.totalShares(), 0);
    }

    // ------------------------------------------------------------ fuzz: money paths

    /// Σ claims for a breached epoch never exceed the pot or any vault's real loss, for any caps/moves.
    function testFuzz_claimsBoundedByPotAndLoss(uint128 capB, uint128 capC, uint16 dropBps, uint96 uwAmt) public {
        capB = uint128(bound(capB, 10e6, 3_000e6));
        capC = uint128(bound(capC, 10e6, 3_000e6));
        dropBps = uint16(bound(dropBps, 1_300, 5_000));
        uwAmt = uint96(bound(uwAmt, 0, 500e6));
        LeaderBook lb = _leader(2_000e6, 800e6);
        if (uwAmt > 0) {
            vm.startPrank(uw);
            ausd.approve(address(lb.pool()), type(uint256).max);
            lb.pool().deposit(uwAmt);
            vm.stopPrank();
        }
        FollowerVault vb = _vault(bob, lb, 1_000e6, capB);
        FollowerVault vc = _vault(carol, lb, 1_000e6, capC);
        _roll(lb);
        vb.touch();
        vc.touch();
        _leaderLong(lb, 2_000);
        vb.sync(BTC);
        vc.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * (10_000 - dropBps) / 10_000);
        lb.checkpoint();
        assertTrue(lb.breached(2));
        LeaderBook.Breach memory br = lb.breachOf(2);
        assertEq(br.pot, 800e6 + uwAmt);

        FollowerVault[2] memory vs = [vb, vc];
        address[2] memory owners = [bob, carol];
        for (uint256 i; i < 2; i++) {
            uint256 loss = vs[i].lossIn(2);
            uint256 b0 = ausd.balanceOf(owners[i]);
            if (loss == 0) continue;
            vs[i].claim(lb, 2);
            uint256 got = ausd.balanceOf(owners[i]) - b0;
            assertLe(got, loss);
            assertLe(got, br.pot * lb.capOf(address(vs[i])) / br.capTotal);
        }
        assertLe(lb.breachOf(2).claimed, br.pot);
        // after the window, sweep empties exactly the rest
        _roll(lb);
        _roll(lb);
        _roll(lb);
        uint256 r0 = ausd.balanceOf(reserve);
        uint256 rest = br.pot - lb.breachOf(2).claimed;
        lb.sweep(2);
        assertEq(ausd.balanceOf(reserve) - r0, rest);
    }

    /// Vault deposit/withdraw round trip: only the owner receives funds and nothing is created or lost.
    function testFuzz_vaultDepositWithdrawConserves(uint96 dep, uint96 wd, address stranger) public {
        vm.assume(stranger != bob && stranger != address(0));
        dep = uint96(bound(dep, 10e6, 10_000e6)); // Perpl min account deposit
        vm.startPrank(bob);
        FollowerVault v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(dep);
        vm.stopPrank();
        wd = uint96(bound(wd, 1, dep));

        vm.prank(stranger);
        vm.expectRevert(CopasErrors.NotOwner.selector);
        v.withdraw(wd);

        uint256 b0 = ausd.balanceOf(bob);
        vm.prank(bob);
        v.withdraw(wd);
        assertEq(ausd.balanceOf(bob) - b0, wd);
        (uint256 eq,) = v.equity();
        assertEq(eq, dep - wd);
    }

    /// BreachMarket stays fully collateralised: AUSD held >= the winning side's supply of each series.
    function testFuzz_breachMarketSolvent(uint96 m1, uint96 m2, uint96 pairBack, uint96 redeemAmt, bool breach) public {
        m1 = uint96(bound(m1, 1, 1_000e6));
        m2 = uint96(bound(m2, 1, 1_000e6));
        LeaderBook lb = _leader(1_000e6, 100e6);
        BreachMarket bm = new BreachMarket(reg);
        vm.startPrank(bob);
        ausd.approve(address(bm), type(uint256).max);
        bm.mint(lb, 1, m1, bob);
        vm.stopPrank();
        vm.startPrank(carol);
        ausd.approve(address(bm), type(uint256).max);
        bm.mint(lb, 1, m2, carol);
        vm.stopPrank();
        BreachMarket.Series memory s = bm.series(address(lb), 1);

        pairBack = uint96(bound(pairBack, 0, m1));
        vm.prank(bob);
        bm.redeemPair(lb, 1, pairBack);
        assertEq(ausd.balanceOf(address(bm)), s.up.totalSupply());
        assertEq(s.up.totalSupply(), s.down.totalSupply());

        if (breach) {
            _leaderLong(lb, 1_000);
            perpl.setMark(BTC, BTC_MARK * 85 / 100);
            lb.checkpoint();
        } else {
            _roll(lb);
        }
        BreachToken win = breach ? s.down : s.up;
        redeemAmt = uint96(bound(redeemAmt, 0, m2));
        vm.prank(carol);
        bm.redeem(lb, 1, redeemAmt);
        assertGe(ausd.balanceOf(address(bm)), win.totalSupply());

        // the losing side redeems nothing
        BreachToken lose = breach ? s.up : s.down;
        uint256 tooMuch = win.balanceOf(carol) + 1;
        assertGt(lose.balanceOf(carol), 0);
        vm.prank(carol);
        vm.expectRevert();
        bm.redeem(lb, 1, tooMuch);
    }

    /// Mandate consent: a looser live mandate stops copying until the owner re-accepts it.
    function testFuzz_consentMatchesLooseness(uint32 newFee, uint32 newDD, uint32 newLev) public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        Mandate memory m = _mandate();
        m.feeBps = uint32(bound(newFee, 0, 3_000));
        m.maxDDbps = uint32(bound(newDD, 1, 9_000));
        m.maxLeverageHdths = uint32(bound(newLev, 100, 5_000));
        vm.prank(alice);
        lb.declare(m);
        _roll(lb);
        Mandate memory a = _mandate();
        bool looser = m.feeBps > a.feeBps || m.maxDDbps > a.maxDDbps || m.maxLeverageHdths > a.maxLeverageHdths;
        assertEq(v.consentOk(), !looser);

        vm.prank(alice);
        lb.trade(BTC, 0, 100, BTC_MARK * 101 / 100, 100);
        v.sync(BTC);
        if (looser) assertEq(_lot(BTC, v.accountId()), 0, "no copying under unaccepted terms");
    }
}
