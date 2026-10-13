// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {Leaders} from "./Leaders.s.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry} from "../src/CopasRegistry.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {Mandate} from "../src/CopasTypes.sol";

/// Proof that shorts copy after the PerplLib fix (maxNegPnlCollatBPS 1000): a fresh leader from the new LeaderFactory
/// (LEADER3_KEY, our own test account) opens a 5x BTC short, a fresh vault (FOLLOWER4_KEY) copies it.
/// State in deployments/short-<chainId>.json; reruns only retry the missing trade/copy.
/// forge script script/ShortDemo.s.sol --rpc-url $RPC --broadcast --slow
contract ShortDemo is Leaders {
    function run() external override {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        reg = CopasRegistry(vm.parseJsonAddress(dep, ".registry"));
        ex = IPerplExchange(vm.parseJsonAddress(dep, ".exchange"));
        ausd = IERC20Min(vm.parseJsonAddress(dep, ".ausd"));
        uint256 lk = vm.envUint("LEADER3_KEY");
        uint256 fk = vm.envUint("FOLLOWER4_KEY");
        string memory statePath = string.concat("deployments/short-", vm.toString(block.chainid), ".json");

        if (!vm.exists(statePath)) {
            vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
            if (vm.addr(fk).balance < 0.6 ether) payable(vm.addr(fk)).transfer(0.65 ether - vm.addr(fk).balance);
            if (vm.addr(lk).balance < 0.6 ether) payable(vm.addr(lk)).transfer(0.65 ether - vm.addr(lk).balance);
            if (ausd.balanceOf(vm.addr(fk)) < 100e6) ausd.transfer(vm.addr(fk), 100e6);
            if (ausd.balanceOf(vm.addr(lk)) < 150e6) ausd.transfer(vm.addr(lk), 150e6);
            vm.stopBroadcast();
            LeaderBook lb = _leader(
                lk,
                Mandate({maxDDbps: 2_000, maxLeverageHdths: 500, feeBps: 1_500, epochLen: 1 hours, maxNotionalCNS: 1_000e6, marketsMask: 0x1})
            );
            vm.writeJson(vm.serializeAddress("s", "leader", address(lb)), statePath);
        }
        string memory st = vm.readFile(statePath);
        if (!vm.keyExistsJson(st, ".vault")) {
            address lbA = vm.parseJsonAddress(st, ".leader");
            vm.serializeAddress("s", "leader", lbA);
            vm.writeJson(vm.serializeAddress("s", "vault", address(_follower(fk, LeaderBook(lbA), 10_000, 500, 150e6))), statePath);
            st = vm.readFile(statePath);
        }

        LeaderBook l = LeaderBook(vm.parseJsonAddress(st, ".leader"));
        _open(lk, l, BTC, 1, 60, 500); // 0.0006 BTC short, 5x (orderType 1 = open short)
        _sync(fk, FollowerVault(vm.parseJsonAddress(st, ".vault")), l);
        console.log("leader", address(l), "vault", vm.parseJsonAddress(st, ".vault"));
    }
}
