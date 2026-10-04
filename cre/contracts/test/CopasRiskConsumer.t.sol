// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CopasRiskConsumer, ICopasRegistry} from "../src/CopasRiskConsumer.sol";

contract MockRegistry {
    mapping(address => bool) public isLeaderBook;

    function set(address a) external {
        isLeaderBook[a] = true;
    }
}

contract MockLeader {
    uint256 public checkpoints;
    bool public broken;

    function setBroken() external {
        broken = true;
    }

    function checkpoint() external {
        require(!broken, "boom");
        checkpoints++;
    }
}

contract CopasRiskConsumerTest is Test {
    address constant FWD = 0xB9F79d863261869B234c481D1f9A7af84AeAd192; // testnet MockKeystoneForwarder
    MockRegistry reg;
    CopasRiskConsumer c;
    MockLeader calm;
    MockLeader hot;
    MockLeader deep;

    function setUp() public {
        reg = new MockRegistry();
        c = new CopasRiskConsumer(ICopasRegistry(address(reg)), FWD);
        calm = new MockLeader();
        hot = new MockLeader();
        deep = new MockLeader();
        reg.set(address(calm));
        reg.set(address(hot));
        reg.set(address(deep));
    }

    function _one(address a, uint8 r, uint16 dd) internal pure returns (bytes memory) {
        CopasRiskConsumer.Note[] memory n = new CopasRiskConsumer.Note[](1);
        n[0] = CopasRiskConsumer.Note(a, r, dd, keccak256("note"));
        return abi.encode(n);
    }

    function _three() internal view returns (bytes memory) {
        CopasRiskConsumer.Note[] memory n = new CopasRiskConsumer.Note[](3);
        n[0] = CopasRiskConsumer.Note(address(calm), 1, 40, bytes32(uint256(1)));
        n[1] = CopasRiskConsumer.Note(address(hot), 2, 10, bytes32(uint256(2))); // LLM says high
        n[2] = CopasRiskConsumer.Note(address(deep), 0, 85, bytes32(uint256(3))); // deterministic DD rule
        return abi.encode(n);
    }

    function test_onlyForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(CopasRiskConsumer.InvalidSender.selector, address(this), FWD));
        c.onReport("", _three());
    }

    function test_checkpointsFlaggedLeadersOnly() public {
        vm.prank(FWD);
        c.onReport("", _three());
        assertEq(calm.checkpoints(), 0);
        assertEq(hot.checkpoints(), 1);
        assertEq(deep.checkpoints(), 1);
        (uint8 r, uint16 dd,, bytes32 h) = c.latest(address(deep));
        assertEq(r, 0);
        assertEq(dd, 85);
        assertEq(h, bytes32(uint256(3)));
    }

    function test_skipsUnknownLeader() public {
        MockLeader stranger = new MockLeader();
        vm.prank(FWD);
        c.onReport("", _one(address(stranger), 3, 100));
        assertEq(stranger.checkpoints(), 0);
        (,, uint64 at,) = c.latest(address(stranger));
        assertEq(at, 0);
    }

    function test_revertingCheckpointDoesNotBlockOthers() public {
        hot.setBroken();
        vm.prank(FWD);
        c.onReport("", _three());
        assertEq(deep.checkpoints(), 1);
    }

    function test_expectedAuthor() public {
        address author = address(0xA11CE);
        c.setExpectedAuthor(author);
        bytes memory meta = abi.encodePacked(bytes32(0), bytes10(0), author);
        vm.prank(FWD);
        c.onReport(meta, _one(address(hot), 3, 0));
        assertEq(hot.checkpoints(), 1);

        bytes memory bad = abi.encodePacked(bytes32(0), bytes10(0), address(0xBAD));
        vm.prank(FWD);
        vm.expectRevert(abi.encodeWithSelector(CopasRiskConsumer.InvalidAuthor.selector, address(0xBAD), author));
        c.onReport(bad, _one(address(hot), 3, 0));
    }

    function test_onlyOwnerSetsForwarder() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(CopasRiskConsumer.NotOwner.selector);
        c.setForwarder(address(1));
    }
}
