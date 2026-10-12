// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry} from "../src/CopasRegistry.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {Mandate, FollowParams, LeaderStatus} from "../src/CopasTypes.sol";

/// Demo breach -> slash -> follower claim, in two phases (followers only count from the next epoch).
///   BREACH_PHASE=1: new leader (normal mandate) bonds, starts, opens a BTC long; follower vault copies it.
///                   The leader also declares a 0.01% max-drawdown mandate for epoch 2 (demo device).
///   BREACH_PHASE=2 (>= 1h later, after epochEnd): roll epoch -> leader closes (fees = drawdown) -> Breached,
///                   bond slashed -> follower sync unwinds -> follower claims its loss from the pot.
/// Keys from contracts/.env: DEPLOYER_KEY (funder), LEADER_KEY, FOLLOWER_KEY. State in deployments/breach-<chainId>.json.
/// forge script script/Breach.s.sol --rpc-url $RPC --broadcast --slow
contract Breach is Script {
    function run() external {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        CopasRegistry reg = CopasRegistry(vm.parseJsonAddress(dep, ".registry"));
        IPerplExchange ex = IPerplExchange(vm.parseJsonAddress(dep, ".exchange"));
        IERC20Min ausd = IERC20Min(vm.parseJsonAddress(dep, ".ausd"));
        uint256 btc = vm.envOr("SEED_PERP", uint256(16));
        uint256 leaderKey = vm.envUint("LEADER_KEY");
        uint256 followerKey = vm.envUint("FOLLOWER_KEY");
        string memory statePath = string.concat("deployments/breach-", vm.toString(block.chainid), ".json");
        IPerplExchange.PerpetualInfo memory info = ex.getPerpetualInfo(btc);

        if (vm.envUint("BREACH_PHASE") == 1) {
            uint256 funderKey = vm.envUint("DEPLOYER_KEY");
            vm.startBroadcast(funderKey);
            payable(vm.addr(leaderKey)).transfer(1 ether);
            payable(vm.addr(followerKey)).transfer(1 ether);
            ausd.transfer(vm.addr(leaderKey), 125e6);
            ausd.transfer(vm.addr(followerKey), 100e6);
            vm.stopBroadcast();

            Mandate memory m = Mandate({
                maxDDbps: 1_500,
                maxLeverageHdths: 500,
                feeBps: 1_000,
                epochLen: 1 hours,
                maxNotionalCNS: 1_000e6,
                marketsMask: 0xF
            });
            vm.startBroadcast(leaderKey);
            (address a,) = reg.createLeader(m);
            LeaderBook lb = LeaderBook(a);
            ausd.approve(a, type(uint256).max);
            lb.deposit(100e6);
            lb.postBond(25e6);
            lb.start();
            lb.trade(btc, 0, 40, (info.basePricePNS + info.minAskPriceONS) * 101 / 100, 200); // 0.0004 BTC long, 2x
            m.maxDDbps = 1; // epoch 2: any loss breaches
            lb.declare(m);
            vm.stopBroadcast();

            vm.startBroadcast(followerKey);
            FollowerVault v = FollowerVault(reg.createVault());
            ausd.approve(address(v), type(uint256).max);
            v.deposit(100e6);
            v.follow(
                lb,
                FollowParams({
                    ratioBps: 10_000,
                    maxLeverageHdths: 300,
                    maxChaseBps: 100,
                    priceBandBps: 100,
                    stopLossBps: 0,
                    maxNotionalCNS: 200e6,
                    marketsMask: 0xF
                })
            );
            v.sync(btc);
            vm.stopBroadcast();

            vm.serializeAddress("b", "leaderBook", a);
            string memory json = vm.serializeAddress("b", "vault", address(v));
            vm.writeJson(json, statePath);
            console.log("book", a, "vault", address(v));
            console.log("phase 2 after unix", lb.epochEnd());
            return;
        }

        string memory st = vm.readFile(statePath);
        LeaderBook book = LeaderBook(vm.parseJsonAddress(st, ".leaderBook"));
        FollowerVault vault = FollowerVault(vm.parseJsonAddress(st, ".vault"));
        require(block.timestamp >= book.epochEnd(), "epoch 1 still running");

        vm.startBroadcast(followerKey); // anyone may roll / checkpoint / sync
        book.rollEpoch();
        vm.stopBroadcast();
        uint256 e = book.epoch();

        (IPerplExchange.PositionInfo memory pos,,) = ex.getPosition(btc, book.accountId());
        vm.broadcast(leaderKey);
        book.trade(btc, 2, pos.lotLNS, (info.basePricePNS + info.maxBidPriceONS) * 99 / 100, 100); // close long
        require(book.status() == LeaderStatus.Breached, "no breach: rerun after a price move or call checkpoint()");

        vm.startBroadcast(followerKey);
        vault.sync(btc); // leader breached -> target 0 -> unwind
        uint256 paid = vault.claim(book, e);
        vm.stopBroadcast();
        console.log("breached epoch", e, "pot", book.breachOf(e).pot);
        console.log("follower loss", vault.lossIn(e), "claimed", paid);
    }
}
