// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {UnderwriterPool} from "../src/UnderwriterPool.sol";

interface IFaucet {
    function requestFunds(address to) external;
}

/// Underwriter backs a leader: AUSD into LeaderBook.pool(). Slashed after the leader's own bond, earns a share of released fees.
/// Env: UNDERWRITER_KEY (needs MON), UW_BOOK (default: demo leader), UW_AMOUNT (default 100 AUSD).
/// forge script script/Underwrite.s.sol --rpc-url $RPC --broadcast --slow
contract Underwrite is Script {
    address constant AUSD_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    function run() external {
        LeaderBook lb = LeaderBook(vm.envOr("UW_BOOK", address(0xda695cB060c7e2dF0b5c36EA591eA69399463D90)));
        uint256 amount = vm.envOr("UW_AMOUNT", uint256(100e6));
        uint256 key = vm.envUint("UNDERWRITER_KEY");
        address uw = vm.addr(key);
        UnderwriterPool pool = lb.pool();
        IERC20Min ausd = lb.ausd();
        uint256 protBefore = lb.protection();
        uint256 capBefore = lb.capacity();

        vm.startBroadcast(key);
        if (ausd.balanceOf(uw) < amount) IFaucet(AUSD_FAUCET).requestFunds(uw);
        ausd.approve(address(pool), amount);
        uint256 shares = pool.deposit(amount);
        vm.stopBroadcast();

        console.log("pool", address(pool), "shares minted", shares);
        console.log("pool assets", pool.assets(), "underwriter value", pool.valueOf(uw));
        console.log("protection before/after", protBefore, lb.protection());
        console.log("capacity before/after (bond+equity bound, pool not counted)", capBefore, lb.capacity());
    }
}
