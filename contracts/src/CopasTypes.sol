// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A leader's public promise. Breaking any field during an epoch slashes the bond.
struct Mandate {
    uint32 maxDDbps; // max drawdown of unit price from the epoch high-water mark, in bps
    uint32 maxLeverageHdths; // max effective leverage (gross notional / equity), hundredths (500 = 5x)
    uint32 feeBps; // performance fee on follower profit above their high-water mark
    uint64 epochLen; // seconds
    uint128 maxNotionalCNS; // max gross notional of the leader account
    uint256 marketsMask; // bit i set => market index i of the registry is allowed
}

enum LeaderStatus {
    Active,
    Unbonded,
    Breached
}

enum BreachReason {
    None,
    Drawdown,
    Leverage,
    Notional,
    Market
}

struct FollowParams {
    uint32 ratioBps; // follower lot = leader lot * ratio / 10_000
    uint32 maxLeverageHdths;
    uint32 maxChaseBps; // refuse to add when mark moved this far from leader entry
    uint32 priceBandBps; // IOC limit = mark +/- band
    uint32 stopLossBps; // pause copying when vault equity falls this far within an epoch
    uint128 maxNotionalCNS; // follower exposure cap; also its weight in slash payouts
    uint256 marketsMask;
}

library CopasErrors {
    error NotOwner();
    error NotOperator();
    error NotRegistry();
    error NotVault();
    error NotLeader();
    error BadParams();
    error MarketNotAllowed();
    error MandateViolation(BreachReason reason);
    error NotActive();
    error EpochRunning();
    error InvalidMark();
    error CapacityExceeded();
    error TooEarly();
    error NothingToClaim();
    error AlreadyClaimed();
    error DepositCap();
}
