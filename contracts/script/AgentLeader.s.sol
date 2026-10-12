// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry} from "../src/CopasRegistry.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {AgentLeaderRegistry} from "../src/AgentLeaderRegistry.sol";
import {Mandate} from "../src/CopasTypes.sol";

interface IIdentity8004 {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function tokenURI(uint256 agentId) external view returns (string memory);
}

interface IFaucet {
    function requestFunds(address to) external;
}

/// ERC-8004 agent leader: a human owner bonds a LeaderBook, an AI agent key trades it.
///   owner: faucet AUSD -> register ERC-8004 identity (data: URI) -> agent signs EIP-712 AgentWalletSet ->
///          owner sets agent wallet -> createLeader, deposit 100, bond 50, setOperator(agent), start, link
///   agent: opens 0.0002 BTC long through LeaderBook.trade (the operator path, not the owner's).
/// Keys from contracts/.env: AGENT_OWNER_KEY, AGENT_KEY (both need MON). State in deployments/agent-<chainId>.json.
/// forge script script/AgentLeader.s.sol --rpc-url $RPC --broadcast --slow
contract AgentLeader is Script {
    // ERC-8004 reference IdentityRegistry (typehash present in the testnet implementation bytecode)
    bytes32 constant WALLET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    address constant AUSD_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    function run() external {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        CopasRegistry reg = CopasRegistry(vm.parseJsonAddress(dep, ".registry"));
        AgentLeaderRegistry agents = AgentLeaderRegistry(vm.parseJsonAddress(dep, ".agentRegistry"));
        IIdentity8004 id = IIdentity8004(vm.parseJsonAddress(dep, ".identity8004"));
        IPerplExchange ex = IPerplExchange(vm.parseJsonAddress(dep, ".exchange"));
        IERC20Min ausd = IERC20Min(vm.parseJsonAddress(dep, ".ausd"));
        uint256 btc = vm.envOr("SEED_PERP", uint256(16));
        uint256 ownerKey = vm.envUint("AGENT_OWNER_KEY");
        uint256 agentKey = vm.envUint("AGENT_KEY");
        address owner = vm.addr(ownerKey);
        address agent = vm.addr(agentKey);

        string memory uri = string.concat(
            "data:application/json;base64,",
            vm.toBase64(
                bytes(
                    '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"Copas Momentum Agent",'
                    '"description":"Deterministic BTC momentum on Perpl: long when the 1h close is above the 24h EMA, flat otherwise. '
                    'Max 2x, one IOC order per signal, no discretion. Trades a bonded Copas LeaderBook; breaking its mandate slashes the bond.",'
                    '"services":[],"active":true}'
                )
            )
        );

        vm.startBroadcast(ownerKey);
        if (ausd.balanceOf(owner) < 150e6) IFaucet(AUSD_FAUCET).requestFunds(owner);
        uint256 agentId = id.register(uri);
        vm.stopBroadcast();

        uint256 deadline = block.timestamp + 240; // reference registry caps deadlines a few minutes ahead
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domain(address(id)),
                keccak256(abi.encode(WALLET_TYPEHASH, agentId, agent, owner, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);

        vm.startBroadcast(ownerKey);
        id.setAgentWallet(agentId, agent, deadline, abi.encodePacked(r, s, v));
        (address a,) = reg.createLeader(
            Mandate({
                maxDDbps: 1_500,
                maxLeverageHdths: 500,
                feeBps: 1_000,
                epochLen: 1 hours,
                maxNotionalCNS: 1_000e6,
                marketsMask: 0x1 // BTC only: the strategy trades one market
            })
        );
        LeaderBook lb = LeaderBook(a);
        ausd.approve(a, type(uint256).max);
        lb.deposit(100e6);
        lb.postBond(50e6);
        lb.setOperator(agent);
        lb.start();
        agents.link(lb, agentId);
        vm.stopBroadcast();

        IPerplExchange.PerpetualInfo memory info = ex.getPerpetualInfo(btc);
        vm.broadcast(agentKey);
        lb.trade(btc, 0, 20, (info.basePricePNS + info.minAskPriceONS) * 101 / 100, 200); // 0.0002 BTC long, 2x

        vm.serializeUint("a", "agentId", agentId);
        vm.serializeAddress("a", "owner", owner);
        vm.serializeAddress("a", "agent", agent);
        string memory json = vm.serializeAddress("a", "leaderBook", a);
        vm.writeJson(json, string.concat("deployments/agent-", vm.toString(block.chainid), ".json"));
        console.log("agentId", agentId, "book", a);
        console.log("owner", owner, "agent", agent);
    }

    function _domain(address registry) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                registry
            )
        );
    }
}
