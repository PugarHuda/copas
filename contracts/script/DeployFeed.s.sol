// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {CopasFeed} from "../src/CopasFeed.sol";

/// Adds CopasFeed to an existing deployment: writes `feed` into deployments/<chainId>.json.
/// forge script script/DeployFeed.s.sol --rpc-url $RPC --private-key $DEPLOYER_KEY --broadcast
contract DeployFeed is Script {
    function run() external {
        vm.startBroadcast();
        CopasFeed feed = new CopasFeed();
        vm.stopBroadcast();
        vm.writeJson(string.concat('"', vm.toString(address(feed)), '"'), string.concat("deployments/", vm.toString(block.chainid), ".json"), ".feed");
    }
}
