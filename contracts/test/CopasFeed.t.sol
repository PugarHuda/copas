// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {CopasFeed} from "../src/CopasFeed.sol";

contract CopasFeedTest is Test {
    CopasFeed feed = new CopasFeed();

    function test_keysAndPosts() public {
        address a = makeAddr("a");
        vm.prank(a);
        feed.setFeedKey(bytes32(uint256(7)));
        address[] memory q = new address[](2);
        q[0] = a;
        q[1] = makeAddr("b");
        bytes32[] memory k = feed.feedKeys(q);
        assertEq(k[0], bytes32(uint256(7)));
        assertEq(k[1], bytes32(0));

        vm.startPrank(a);
        feed.post(hex"01");
        feed.post(hex"0203");
        vm.expectRevert("blob size");
        feed.post("");
        vm.stopPrank();
        bytes[] memory p = feed.posts(a);
        assertEq(p.length, 2);
        assertEq(p[1], hex"0203");
    }
}
