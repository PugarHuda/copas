// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {IPerplExchange, IERC20Min} from "../../src/interfaces/IPerplExchange.sol";
import {CopasRegistry, ILeaderFactory, IVaultFactory} from "../../src/CopasRegistry.sol";
import {LeaderFactory, VaultFactory} from "../../src/Factories.sol";
import {LeaderBook} from "../../src/LeaderBook.sol";
import {FollowerVault} from "../../src/FollowerVault.sol";
import {Mandate, FollowParams, LeaderStatus} from "../../src/CopasTypes.sol";

/// Full Copas flow against the real Perpl exchange on a Monad mainnet fork.
/// Run: forge test --match-contract CopasFork --fork-url https://rpc.monad.xyz -vv
contract CopasForkTest is Test {
    IPerplExchange constant EX = IPerplExchange(0x34B6552d57a35a1D042CcAe1951BD1C370112a6F);
    IERC20Min constant AUSD = IERC20Min(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
    uint256 constant BTC = 1;

    CopasRegistry reg;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function _deal(address to, uint256 amount) internal {
        vm.record();
        AUSD.balanceOf(to);
        (bytes32[] memory reads,) = vm.accesses(address(AUSD));
        bytes32 slot = reads[reads.length - 1];
        uint256 cur = uint256(vm.load(address(AUSD), slot));
        vm.store(address(AUSD), slot, bytes32((amount << 8) | (cur & 0xff)));
    }

    function setUp() public {
        reg = new CopasRegistry(EX, AUSD, makeAddr("reserve"));
        reg.setFactories(ILeaderFactory(address(new LeaderFactory(reg))), IVaultFactory(address(new VaultFactory(reg))));
        reg.addMarket(1, 1, 5); // BTC
        reg.addMarket(10, 6, 0); // MON
        reg.addMarket(20, 2, 3); // ETH
        reg.addMarket(31, 3, 3); // SOL
        _deal(alice, 1_000e6);
        _deal(bob, 1_000e6);
    }

    function test_fork_leaderTradesFollowerCopiesOnRealPerpl() public {
        Mandate memory m = Mandate({
            maxDDbps: 1_500,
            maxLeverageHdths: 500,
            feeBps: 1_000,
            epochLen: 1 hours,
            maxNotionalCNS: 1_000e6,
            marketsMask: 0xF
        });
        vm.startPrank(alice);
        (address a,) = reg.createLeader(m);
        LeaderBook lb = LeaderBook(a);
        AUSD.approve(a, type(uint256).max);
        lb.deposit(100e6);
        lb.postBond(50e6);
        lb.start();
        vm.stopPrank();
        assertEq(uint256(lb.status()), uint256(LeaderStatus.Active));

        vm.startPrank(bob);
        FollowerVault v = FollowerVault(reg.createVault());
        AUSD.approve(address(v), type(uint256).max);
        v.deposit(50e6);
        v.follow(
            lb,
            FollowParams({
                ratioBps: 5_000,
                maxLeverageHdths: 300,
                maxChaseBps: 100,
                priceBandBps: 100,
                stopLossBps: 0,
                maxNotionalCNS: 200e6,
                marketsMask: 0xF
            })
        );
        vm.stopPrank();

        IPerplExchange.PerpetualInfo memory info = EX.getPerpetualInfo(BTC);
        uint256 ask = info.basePricePNS + info.minAskPriceONS;
        vm.prank(alice);
        lb.trade(BTC, 0, 20, ask * 101 / 100, 200); // 0.0002 BTC
        (IPerplExchange.PositionInfo memory lp,,) = EX.getPosition(BTC, lb.accountId());
        assertEq(lp.lotLNS, 20, "leader not filled");

        int256 t = v.sync(BTC);
        assertEq(t, 10);
        (IPerplExchange.PositionInfo memory fp,,) = EX.getPosition(BTC, v.accountId());
        assertEq(fp.lotLNS, 10, "follower not filled");
        emit log_named_uint("leader entry", lp.pricePNS);
        emit log_named_uint("follower entry", fp.pricePNS);

        lb.checkpoint();
        (uint256 eq,) = lb.equity();
        emit log_named_uint("leader equity", eq);

        uint256 bid = info.basePricePNS + info.maxBidPriceONS;
        vm.prank(alice);
        lb.trade(BTC, 2, 20, bid * 99 / 100, 100);
        v.sync(BTC);
        (fp,,) = EX.getPosition(BTC, v.accountId());
        assertEq(fp.lotLNS, 0, "follower not closed");
    }
}
