// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry} from "../src/CopasRegistry.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {Mandate, FollowParams} from "../src/CopasTypes.sol";

/// Demo seed on a deployed Copas (same flow as test/fork/CopasFork.t.sol):
/// funder sends MON + AUSD -> leader bonds and starts -> follower vault follows -> leader opens BTC long -> sync copies it.
/// Needs contracts/.env: DEPLOYER_KEY (funder, >= 250 AUSD), LEADER_KEY, FOLLOWER_KEY.
/// forge script script/Seed.s.sol --rpc-url $RPC --broadcast --slow
contract Seed is Script {
    function run() external {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        CopasRegistry reg = CopasRegistry(vm.parseJsonAddress(dep, ".registry"));
        IPerplExchange ex = IPerplExchange(vm.parseJsonAddress(dep, ".exchange"));
        IERC20Min ausd = IERC20Min(vm.parseJsonAddress(dep, ".ausd"));
        uint256 btc = vm.envOr("SEED_PERP", uint256(16)); // testnet BTC; mainnet = 1
        uint256 funderKey = vm.envUint("DEPLOYER_KEY");
        uint256 leaderKey = vm.envUint("LEADER_KEY");
        uint256 followerKey = vm.envUint("FOLLOWER_KEY");
        address leader = vm.addr(leaderKey);
        address follower = vm.addr(followerKey);

        require(ausd.balanceOf(vm.addr(funderKey)) >= 250e6, "funder needs >= 250 AUSD");

        vm.startBroadcast(funderKey);
        payable(leader).transfer(1 ether);
        payable(follower).transfer(1 ether);
        ausd.transfer(leader, 150e6);
        ausd.transfer(follower, 100e6); // testnet Perpl rejects accounts opened with 50
        vm.stopBroadcast();

        vm.startBroadcast(leaderKey);
        (address a,) = reg.createLeader(
            Mandate({
                maxDDbps: 1_500,
                maxLeverageHdths: 500,
                feeBps: 1_000,
                epochLen: 1 hours,
                maxNotionalCNS: 1_000e6,
                marketsMask: 0xF
            })
        );
        LeaderBook lb = LeaderBook(a);
        ausd.approve(a, type(uint256).max);
        lb.deposit(100e6);
        lb.postBond(50e6);
        lb.start();
        vm.stopBroadcast();

        vm.startBroadcast(followerKey);
        FollowerVault v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(100e6);
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
        vm.stopBroadcast();

        IPerplExchange.PerpetualInfo memory info = ex.getPerpetualInfo(btc);
        vm.broadcast(leaderKey);
        lb.trade(btc, 0, 20, (info.basePricePNS + info.minAskPriceONS) * 101 / 100, 200); // 0.0002 BTC long, 2x

        vm.broadcast(followerKey); // anyone may sync; follower pays gas here
        v.sync(btc);

        console.log("leader", leader, "book", a);
        console.log("follower", follower, "vault", address(v));
    }
}
