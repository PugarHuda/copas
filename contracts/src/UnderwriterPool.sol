// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min} from "./interfaces/IPerplExchange.sol";
import {CopasErrors} from "./CopasTypes.sol";

interface ILeaderEpoch {
    function epoch() external view returns (uint256);
    function registry() external view returns (address);
}

interface IRegistryDelay {
    function unbondDelayEpochs() external view returns (uint256);
}

/// @notice Third parties back a leader's bond. They earn a share of the leader's released fees and
/// are slashed after the leader's own bond (leader = first loss).
contract UnderwriterPool {
    IERC20Min public immutable ausd;
    address public immutable leaderBook;

    /// @dev Virtual shares/assets (OpenZeppelin ERC-4626 style offset): a donation can't round a depositor
    /// down to zero, and shares left worthless by a full slash can't dilute the next deposit. 1:1 at start.
    uint256 internal constant V = 1e3;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public pendingShares;
    mapping(address => uint256) public unlockEpoch;

    event Deposited(address indexed who, uint256 amount, uint256 shares);
    event WithdrawRequested(address indexed who, uint256 shares, uint256 unlockEpoch);
    event Withdrawn(address indexed who, uint256 amount, uint256 shares);
    event Slashed(uint256 amount);
    event FeeReceived(uint256 amount);

    constructor(IERC20Min _ausd, address _leaderBook) {
        ausd = _ausd;
        leaderBook = _leaderBook;
    }

    function assets() public view returns (uint256) {
        return ausd.balanceOf(address(this));
    }

    function valueOf(address who) external view returns (uint256) {
        return _value(sharesOf[who]);
    }

    function deposit(uint256 amount) external returns (uint256 shares) {
        uint256 a = assets();
        shares = amount * (totalShares + V) / (a + V);
        if (shares == 0) revert CopasErrors.BadParams();
        ausd.transferFrom(msg.sender, address(this), amount);
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Shares stay exposed to slashing until unlocked.
    function requestWithdraw(uint256 shares) external {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert CopasErrors.BadParams();
        uint256 delay = IRegistryDelay(ILeaderEpoch(leaderBook).registry()).unbondDelayEpochs();
        pendingShares[msg.sender] = shares;
        unlockEpoch[msg.sender] = ILeaderEpoch(leaderBook).epoch() + 1 + delay;
        emit WithdrawRequested(msg.sender, shares, unlockEpoch[msg.sender]);
    }

    function withdraw() external returns (uint256 amount) {
        uint256 shares = pendingShares[msg.sender];
        if (shares == 0) revert CopasErrors.NothingToClaim();
        // only in the unlock epoch itself: an open-ended unlock would be a free option to exit right before a breach
        if (ILeaderEpoch(leaderBook).epoch() != unlockEpoch[msg.sender]) revert CopasErrors.TooEarly();
        if (shares > sharesOf[msg.sender]) shares = sharesOf[msg.sender];
        amount = _value(shares);
        pendingShares[msg.sender] = 0;
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        ausd.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shares);
    }

    function _value(uint256 shares) internal view returns (uint256 v) {
        uint256 a = assets();
        v = shares * (a + V) / (totalShares + V);
        if (v > a) v = a; // the virtual assets are not real
    }

    /// @notice Called by the leader book on breach. Takes up to `amount`.
    function slash(uint256 amount) external returns (uint256 taken) {
        if (msg.sender != leaderBook) revert CopasErrors.NotLeader();
        uint256 a = assets();
        taken = amount < a ? amount : a;
        if (taken > 0) ausd.transfer(leaderBook, taken);
        emit Slashed(taken);
    }

    /// @notice Leader book pushes fee share in (already transferred). Raises share value.
    function notifyFee(uint256 amount) external {
        if (msg.sender != leaderBook) revert CopasErrors.NotLeader();
        emit FeeReceived(amount);
    }
}
