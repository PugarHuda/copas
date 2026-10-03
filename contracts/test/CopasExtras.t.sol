// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {CopasBase} from "./Copas.t.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {BreachMarket, BreachToken} from "../src/BreachMarket.sol";
import {AgentLeaderRegistry, IIdentityRegistry8004} from "../src/AgentLeaderRegistry.sol";
import {CopasErrors} from "../src/CopasTypes.sol";

contract MockIdentity is IIdentityRegistry8004 {
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;

    function set(uint256 id, address o, address w) external {
        owners[id] = o;
        wallets[id] = w;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return owners[id];
    }

    function getAgentWallet(uint256 id) external view returns (address) {
        return wallets[id];
    }
}

contract CopasExtrasTest is CopasBase {
    function test_breachMarket_downPaysOnBreach() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        BreachMarket bm = new BreachMarket(reg);
        vm.startPrank(carol);
        ausd.approve(address(bm), type(uint256).max);
        bm.mint(lb, 1, 50e6, carol);
        vm.stopPrank();
        BreachMarket.Series memory s = bm.series(address(lb), 1);
        assertEq(s.down.balanceOf(carol), 50e6);

        vm.expectRevert(CopasErrors.EpochRunning.selector);
        bm.settle(lb, 1);

        _leaderLong(lb, 1_000);
        perpl.setMark(BTC, BTC_MARK * 85 / 100);
        lb.checkpoint();
        assertTrue(lb.breached(1));

        uint256 b0 = ausd.balanceOf(carol);
        vm.prank(carol);
        bm.redeem(lb, 1, 50e6); // DOWN wins
        assertEq(ausd.balanceOf(carol) - b0, 50e6);
        vm.prank(carol);
        vm.expectRevert(); // UP is worthless: burning DOWN again fails (balance 0)
        bm.redeem(lb, 1, 1);
    }

    function test_breachMarket_upPaysWithoutBreach() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        BreachMarket bm = new BreachMarket(reg);
        vm.startPrank(carol);
        ausd.approve(address(bm), type(uint256).max);
        bm.mint(lb, 1, 10e6, carol);
        vm.stopPrank();
        _roll(lb);
        uint256 b0 = ausd.balanceOf(carol);
        vm.prank(carol);
        bm.redeem(lb, 1, 10e6);
        assertEq(ausd.balanceOf(carol) - b0, 10e6);
    }

    function test_agentLink_requiresOwnerAndOperatorWallet() public {
        LeaderBook lb = _leader(1_000e6, 100e6);
        MockIdentity id = new MockIdentity();
        AgentLeaderRegistry ar = new AgentLeaderRegistry(reg, id);
        address agentWallet = makeAddr("agentWallet");
        id.set(7, alice, agentWallet);

        vm.prank(alice);
        vm.expectRevert(CopasErrors.NotOperator.selector);
        ar.link(lb, 7);

        vm.startPrank(alice);
        lb.setOperator(agentWallet);
        ar.link(lb, 7);
        vm.stopPrank();
        assertEq(ar.agentOf(address(lb)), 7);
        assertTrue(ar.isAgent(address(lb)));

        // the agent trades within the mandate; the owner's bond stands behind it
        vm.prank(agentWallet);
        lb.trade(BTC, 0, 100, BTC_MARK * 101 / 100, 200);
    }
}
