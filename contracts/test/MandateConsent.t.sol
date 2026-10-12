// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CopasBase} from "./Copas.t.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {Mandate, CopasErrors} from "../src/CopasTypes.sol";

/// A leader can change its mandate (effective next epoch), but a vault only copies under terms its owner accepted.
contract MandateConsentTest is CopasBase {
    function _declare(LeaderBook lb, Mandate memory m) internal {
        vm.prank(alice);
        lb.declare(m);
    }

    function test_followSnapshotsMandate() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        assertEq(v.accepted().feeBps, _mandate().feeBps);
        assertTrue(v.consentOk());
    }

    function test_looserMandateStopsCopyUntilAccepted() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 500);

        Mandate memory looser = _mandate();
        looser.maxDDbps = 3_000; // 10% -> 30%
        _declare(lb, looser);
        assertTrue(v.consentOk(), "pending change is not live yet");
        _roll(lb);
        assertFalse(v.consentOk());
        v.sync(BTC); // anyone: unwinds to flat
        assertEq(_lot(BTC, v.accountId()), 0);

        vm.prank(bob);
        v.acceptMandate(looser);
        assertTrue(v.consentOk());
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 500);
    }

    function test_preAcceptPendingKeepsCopying() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        _leaderLong(lb, 1_000);
        Mandate memory looser = _mandate();
        looser.feeBps = 3_000;
        _declare(lb, looser);
        vm.prank(bob);
        v.acceptMandate(looser);
        _roll(lb);
        assertTrue(v.consentOk());
        v.sync(BTC);
        assertEq(_lot(BTC, v.accountId()), 500);
    }

    function test_tighterMandateNeedsNoConsent() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        Mandate memory tighter = _mandate();
        tighter.maxDDbps = 500;
        tighter.feeBps = 1_000;
        tighter.marketsMask = 0x1;
        _declare(lb, tighter);
        _roll(lb);
        assertTrue(v.consentOk());
    }

    function test_acceptRejectsTermsTheLeaderDidNotDeclare() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 1_000e6);
        Mandate memory made = _mandate();
        made.feeBps = 3_000;
        vm.prank(bob);
        vm.expectRevert(CopasErrors.BadParams.selector);
        v.acceptMandate(made);
        vm.prank(carol);
        vm.expectRevert(CopasErrors.NotOwner.selector);
        v.acceptMandate(_mandate());
    }

    /// The leader raises its fee 20% -> 30% for the next epoch. Carol accepts, Bob does not: Bob still pays 20%.
    function test_feeChargedAtAcceptedRate() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        FollowerVault v = _vault(bob, lb, 500e6, 400e6);
        FollowerVault w = _vault(carol, lb, 500e6, 400e6);
        _roll(lb);
        v.touch();
        w.touch();
        _leaderLong(lb, 1_000);
        v.sync(BTC);
        w.sync(BTC);
        perpl.setMark(BTC, BTC_MARK * 105 / 100); // profit for both
        vm.prank(alice);
        lb.trade(BTC, 2, 1_000, BTC_MARK * 104 / 100, 100);
        v.sync(BTC);
        w.sync(BTC);

        Mandate memory greedy = _mandate();
        greedy.feeBps = 3_000;
        _declare(lb, greedy);
        vm.prank(carol);
        w.acceptMandate(greedy);
        _roll(lb); // fees on epoch 2 profit are charged under the 30% mandate
        uint256 e0 = lb.feeEscrow();
        v.touch();
        uint256 bobFee = lb.feeEscrow() - e0;
        w.touch();
        uint256 carolFee = lb.feeEscrow() - e0 - bobFee;
        assertGt(bobFee, 0);
        assertApproxEqRel(bobFee * 3, carolFee * 2, 1e15, "bob should pay 20%, carol 30%");
    }
}
