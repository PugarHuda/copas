// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Chainlink CRE receiver interface (same selector as @chainlink/contracts cre/src/v1/interfaces/IReceiver.sol).
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface ICopasRegistry {
    function isLeaderBook(address) external view returns (bool);
}

interface ILeaderBook {
    function checkpoint() external;
}

/// @notice Receives DON-signed risk reports from the `copas-risk-guardian` CRE workflow.
/// Stores the latest note per leader and calls the permissionless `LeaderBook.checkpoint()` for every
/// leader the report flags, so a breach is detected (and the bond slashed to followers) even when no
/// keeper or follower is online. CRE only triggers the deterministic onchain check: it cannot slash,
/// move funds or change a mandate (SPEC §1.5 "AI explains, does not execute").
contract CopasRiskConsumer is IReceiver, IERC165 {
    struct Note {
        address leader;
        uint8 riskLevel; // 0 ok · 1 watch · 2 high · 3 critical (DON median of the LLM score)
        uint16 ddToLimitPct; // current drawdown as % of the mandate's maxDD (deterministic, from LeaderBook state)
        bytes32 noteHash; // keccak256 of the note string logged by the workflow
    }

    struct Latest {
        uint8 riskLevel;
        uint16 ddToLimitPct;
        uint64 at;
        bytes32 noteHash;
    }

    uint8 public constant CHECKPOINT_RISK = 2;
    uint16 public constant CHECKPOINT_DD_PCT = 80;

    ICopasRegistry public immutable registry;
    address public owner;
    address public forwarder; // MockKeystoneForwarder for `cre workflow simulate --broadcast`, KeystoneForwarder in prod
    address public expectedAuthor; // optional: workflow owner, checked against report metadata when set

    mapping(address => Latest) public latest;

    event RiskNote(address indexed leader, uint8 riskLevel, uint16 ddToLimitPct, bytes32 noteHash);
    event CheckpointCalled(address indexed leader, bool ok);
    event ForwarderSet(address forwarder);
    event ExpectedAuthorSet(address author);

    error InvalidSender(address sender, address expected);
    error InvalidAuthor(address received, address expected);
    error NotOwner();
    error ZeroAddress();

    constructor(ICopasRegistry _registry, address _forwarder) {
        if (address(_registry) == address(0) || _forwarder == address(0)) revert ZeroAddress();
        registry = _registry;
        owner = msg.sender;
        forwarder = _forwarder;
        emit ForwarderSet(_forwarder);
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        if (expectedAuthor != address(0)) {
            // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
            address author = address(bytes20(metadata[42:62]));
            if (author != expectedAuthor) revert InvalidAuthor(author, expectedAuthor);
        }

        Note[] memory notes = abi.decode(report, (Note[]));
        for (uint256 i; i < notes.length; i++) {
            Note memory n = notes[i];
            if (!registry.isLeaderBook(n.leader)) continue; // only Copas leaders, never arbitrary calls
            latest[n.leader] = Latest(n.riskLevel, n.ddToLimitPct, uint64(block.timestamp), n.noteHash);
            emit RiskNote(n.leader, n.riskLevel, n.ddToLimitPct, n.noteHash);

            if (n.riskLevel >= CHECKPOINT_RISK || n.ddToLimitPct >= CHECKPOINT_DD_PCT) {
                // one reverting leader must not block the others
                try ILeaderBook(n.leader).checkpoint() {
                    emit CheckpointCalled(n.leader, true);
                } catch {
                    emit CheckpointCalled(n.leader, false);
                }
            }
        }
    }

    function setForwarder(address f) external {
        if (msg.sender != owner) revert NotOwner();
        if (f == address(0)) revert ZeroAddress();
        forwarder = f;
        emit ForwarderSet(f);
    }

    function setExpectedAuthor(address a) external {
        if (msg.sender != owner) revert NotOwner();
        expectedAuthor = a;
        emit ExpectedAuthorSet(a);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IReceiver).interfaceId || id == type(IERC165).interfaceId;
    }
}
