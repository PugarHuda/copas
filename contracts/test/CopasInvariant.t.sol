// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {CopasBase} from "./Copas.t.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {MockPerpl, MockAUSD} from "./mocks/MockPerpl.sol";
import {LeaderStatus} from "../src/CopasTypes.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";

/// @dev Random walk over leader trades, price moves, syncs, checkpoints, rolls and claims.
contract Handler is Test {
    LeaderBook public lb;
    FollowerVault[] public vaults;
    MockPerpl public perpl;
    address public alice;
    uint256 constant BTC = 1;
    uint256 public mark = 850000;
    uint256 public syncWrongSide; // ghost: times a synced follower ended opposite the leader

    constructor(LeaderBook _lb, FollowerVault[] memory _v, MockPerpl _p, address _alice) {
        lb = _lb;
        vaults = _v;
        perpl = _p;
        alice = _alice;
    }

    function _lot(uint256 acct) internal view returns (int256) {
        (IPerplExchange.PositionInfo memory p,,) = perpl.getPosition(BTC, acct);
        return p.positionType == 0 ? int256(p.lotLNS) : -int256(p.lotLNS);
    }

    function move(uint256 bps, bool up) external {
        bps = bound(bps, 1, 800);
        mark = up ? mark * (10_000 + bps) / 10_000 : mark * (10_000 - bps) / 10_000;
        if (mark < 10_000) mark = 10_000;
        perpl.setMark(BTC, mark);
    }

    function leaderOpen(uint256 lot, bool long_) external {
        lot = bound(lot, 1, 800);
        int256 cur = _lot(lb.accountId());
        vm.startPrank(alice);
        if (cur != 0 && (cur > 0) != long_) {
            try lb.trade(BTC, cur > 0 ? 2 : 3, uint256(cur > 0 ? cur : -cur), cur > 0 ? mark * 99 / 100 : mark * 101 / 100, 100) {} catch {}
        }
        try lb.trade(BTC, long_ ? 0 : 1, lot, long_ ? mark * 101 / 100 : mark * 99 / 100, 300) {} catch {}
        vm.stopPrank();
    }

    function leaderClose(uint256 frac) external {
        int256 cur = _lot(lb.accountId());
        if (cur == 0) return;
        uint256 abs_ = uint256(cur > 0 ? cur : -cur);
        uint256 lot = bound(frac, 1, abs_);
        vm.prank(alice);
        try lb.trade(BTC, cur > 0 ? 2 : 3, lot, cur > 0 ? mark * 99 / 100 : mark * 101 / 100, 100) {} catch {}
    }

    function sync(uint256 i) external {
        FollowerVault v = vaults[i % vaults.length];
        try v.sync(BTC) {
            int256 l = _lot(lb.accountId());
            int256 f = _lot(v.accountId());
            if (f != 0 && (l == 0 || (l > 0) != (f > 0))) {
                // allowed only while unwinding (leader not active / follower paused)
                if (lb.status() == LeaderStatus.Active && !v.paused() && v.following()) syncWrongSide++;
            }
        } catch {}
    }

    function checkpoint() external {
        lb.checkpoint();
    }

    function roll() external {
        vm.warp(block.timestamp + 1 hours + 1);
        try lb.rollEpoch() {} catch {}
        for (uint256 i; i < vaults.length; i++) {
            try vaults[i].touch() {} catch {}
        }
    }

    function claim(uint256 i, uint256 e) external {
        FollowerVault v = vaults[i % vaults.length];
        e = bound(e, 1, lb.epoch());
        try v.claim(lb, e) {} catch {}
    }

    function rebond(uint256 amt) external {
        amt = bound(amt, 1e6, 500e6);
        vm.prank(alice);
        lb.postBond(amt);
    }
}

contract CopasInvariantTest is CopasBase {
    Handler h;
    LeaderBook lb;

    function setUp() public override {
        super.setUp();
        lb = _leader(2_000e6, 300e6);
        FollowerVault[] memory vs = new FollowerVault[](2);
        vs[0] = _vault(bob, lb, 800e6, 2_000e6);
        vs[1] = _vault(carol, lb, 400e6, 1_000e6);
        h = new Handler(lb, vs, perpl, alice);
        targetContract(address(h));
    }

    /// Σ claimed never exceeds the slashed pot, for every epoch.
    function invariant_claimsNeverExceedPot() public view {
        for (uint256 e = 1; e <= lb.epoch(); e++) {
            LeaderBook.Breach memory b = lb.breachOf(e);
            assertLe(b.claimed, b.pot);
        }
    }

    /// The leader book always holds enough AUSD for bond + escrow + claimable fees + open pots.
    function invariant_leaderBookSolvent() public view {
        uint256 owed = lb.bond() + lb.feeEscrow() + lb.feeClaimable();
        for (uint256 e = 1; e <= lb.epoch(); e++) {
            LeaderBook.Breach memory b = lb.breachOf(e);
            if (!b.swept) owed += b.pot - b.claimed;
        }
        assertGe(ausd.balanceOf(address(lb)), owed);
    }

    /// While the leader is active and the follower is copying, sync never leaves it on the opposite side.
    function invariant_syncNeverOppositeLeader() public view {
        assertEq(h.syncWrongSide(), 0);
    }
}
