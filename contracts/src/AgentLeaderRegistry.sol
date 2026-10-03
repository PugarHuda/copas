// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CopasRegistry} from "./CopasRegistry.sol";
import {LeaderBook} from "./LeaderBook.sol";
import {CopasErrors} from "./CopasTypes.sol";

interface IIdentityRegistry8004 {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Links a LeaderBook to an ERC-8004 agent identity. A linked leader is an AI agent that trades
/// through `LeaderBook.operator` while its owner's bond stands behind it ("an agent that can lose its own money").
/// Monad mainnet IdentityRegistry: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
contract AgentLeaderRegistry {
    CopasRegistry public immutable registry;
    IIdentityRegistry8004 public immutable identity;

    mapping(address => uint256) public agentOf; // leaderBook => agentId (0 = human)
    mapping(uint256 => address) public leaderOfAgent;

    event AgentLinked(address indexed leaderBook, uint256 indexed agentId, address agentWallet);
    event AgentUnlinked(address indexed leaderBook, uint256 indexed agentId);

    constructor(CopasRegistry r, IIdentityRegistry8004 id) {
        registry = r;
        identity = id;
    }

    /// @dev The leader owner must own the agent NFT, and the book's operator must be the agent's wallet.
    function link(LeaderBook lb, uint256 agentId) external {
        if (!registry.isLeaderBook(address(lb))) revert CopasErrors.NotLeader();
        if (msg.sender != lb.owner() || identity.ownerOf(agentId) != msg.sender) revert CopasErrors.NotOwner();
        address wallet = identity.getAgentWallet(agentId);
        if (wallet != lb.operator()) revert CopasErrors.NotOperator();
        if (leaderOfAgent[agentId] != address(0)) revert CopasErrors.BadParams();
        agentOf[address(lb)] = agentId;
        leaderOfAgent[agentId] = address(lb);
        emit AgentLinked(address(lb), agentId, wallet);
    }

    function unlink(LeaderBook lb) external {
        if (msg.sender != lb.owner()) revert CopasErrors.NotOwner();
        uint256 id = agentOf[address(lb)];
        delete leaderOfAgent[id];
        delete agentOf[address(lb)];
        emit AgentUnlinked(address(lb), id);
    }

    function isAgent(address lb) external view returns (bool) {
        return agentOf[lb] != 0;
    }
}
