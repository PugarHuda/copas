// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange, IERC20Min} from "./interfaces/IPerplExchange.sol";
import {PerplLib} from "./lib/PerplLib.sol";
import {Mandate, LeaderStatus, FollowParams, CopasErrors} from "./CopasTypes.sol";
import {CopasRegistry} from "./CopasRegistry.sol";
import {LeaderBook} from "./LeaderBook.sol";

/// @notice A follower's own Perpl account. Funds only ever leave to `owner`.
/// `sync` is permissionless and can only move this account toward ratio x the leader's live position,
/// inside the follower's own limits. Backends (keeper) have no discretion.
contract FollowerVault {
    using PerplLib for IPerplExchange;

    CopasRegistry public immutable registry;
    IPerplExchange public immutable exchange;
    IERC20Min public immutable ausd;
    address public immutable owner;

    uint256 public accountId;
    LeaderBook public leader; // current or last followed leader
    bool public following;
    bool public paused; // stop-loss tripped for this epoch
    FollowParams internal _params;

    uint256 public epochSeen;
    mapping(uint256 => uint256) public startEquity; // vault equity when epoch e was first seen
    mapping(uint256 => int256) public netFlow; // deposits - withdrawals during epoch e
    mapping(uint256 => uint256) public endEquity; // equity when the vault moved past epoch e
    uint256 public highWaterMark; // for performance fees
    address public referrer; // earns part of the protocol's fee cut
    /// @notice Leader terms the owner agreed to. A live mandate looser than this stops copying (target 0)
    /// and the fee is charged at the agreed rate, so a leader cannot change the deal under a follower.
    Mandate internal _accepted;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(uint256 amount);
    event Followed(address indexed leader, FollowParams p);
    event Unfollowed(address indexed leader);
    event Synced(uint256 indexed perpId, int256 leaderLot, int256 fromLot, int256 targetLot, uint256 mark);
    event SkippedChase(uint256 indexed perpId, uint256 mark, uint256 leaderEntry);
    event StopLoss(uint256 indexed epoch, uint256 equity, uint256 start);
    event FeePaid(uint256 indexed epoch, uint256 toLeader, uint256 toProtocol);
    event ClaimedSlash(uint256 indexed epoch, uint256 loss, uint256 amount);
    event ReferrerSet(address indexed referrer);
    event ReferralPaid(address indexed referrer, uint256 amount);
    event MandateAccepted(address indexed leader, Mandate m);

    modifier onlyOwner() {
        if (msg.sender != owner) revert CopasErrors.NotOwner();
        _;
    }

    constructor(CopasRegistry _registry, address _owner) {
        registry = _registry;
        exchange = _registry.exchange();
        ausd = _registry.ausd();
        owner = _owner;
    }

    // ================================================================ views

    function params() external view returns (FollowParams memory) {
        return _params;
    }

    function accepted() external view returns (Mandate memory) {
        return _accepted;
    }

    /// @notice False when the leader's live mandate is looser than the one this vault accepted.
    function consentOk() public view returns (bool) {
        return _within(leader.mandate(), _accepted);
    }

    function equity() public view returns (uint256 eq, bool valid) {
        return exchange.equity(accountId, registry.markets());
    }

    /// @notice Loss in epoch e measured from its start, net of deposits/withdrawals.
    function lossIn(uint256 e) public view returns (uint256) {
        uint256 base;
        int256 b = int256(startEquity[e]) + netFlow[e];
        if (b <= 0) return 0;
        base = uint256(b);
        uint256 end_;
        if (e == epochSeen) {
            (end_,) = equity();
        } else {
            end_ = endEquity[e];
        }
        return base > end_ ? base - end_ : 0;
    }

    // ================================================================ capital

    /// @notice Anyone can fund an owner's vault (e.g. a cross-chain deposit-and-follow flow).
    function deposit(uint256 amount) public {
        (uint256 eq,) = equity();
        if (eq + amount > registry.maxVaultDepositCNS()) revert CopasErrors.DepositCap();
        ausd.transferFrom(msg.sender, address(this), amount);
        if (accountId == 0) {
            ausd.approve(address(exchange), type(uint256).max);
            accountId = exchange.createAccount(amount);
        } else {
            exchange.depositCollateral(amount);
        }
        if (following) {
            _touchEpoch();
            netFlow[epochSeen] += int256(amount);
        }
        highWaterMark += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner {
        exchange.withdrawCollateral(amount);
        ausd.transfer(owner, amount);
        if (following) {
            _touchEpoch();
            netFlow[epochSeen] -= int256(amount);
        }
        highWaterMark = highWaterMark > amount ? highWaterMark - amount : 0;
        emit Withdrawn(amount);
    }

    /// @notice One-time referral tag (H4). Cannot be changed once set.
    function setReferrer(address r) external onlyOwner {
        if (referrer != address(0) || r == address(0) || r == owner) revert CopasErrors.BadParams();
        referrer = r;
        emit ReferrerSet(r);
    }

    // ================================================================ follow

    function follow(LeaderBook lb, FollowParams calldata p) external onlyOwner {
        if (!registry.isLeaderBook(address(lb))) revert CopasErrors.NotLeader();
        if (following) revert CopasErrors.BadParams();
        if (
            p.ratioBps == 0 || p.ratioBps > 50_000 || p.priceBandBps == 0 || p.priceBandBps > 500 || p.maxChaseBps > 2_000
                || p.maxNotionalCNS == 0 || p.maxLeverageHdths < 100 || p.marketsMask == 0
        ) revert CopasErrors.BadParams();
        lb.registerFollower(p.maxNotionalCNS);
        leader = lb;
        following = true;
        paused = false;
        _params = p;
        _accepted = lb.mandate();
        emit MandateAccepted(address(lb), _accepted);
        epochSeen = 0;
        _touchEpoch();
        (uint256 eq,) = equity();
        highWaterMark = eq;
        emit Followed(address(lb), p);
    }

    /// @notice Stops copying. Open positions are unwound by `sync` (target becomes 0).
    function unfollow() external onlyOwner {
        if (!following) revert CopasErrors.BadParams();
        _touchEpoch();
        following = false;
        leader.unregisterFollower();
        emit Unfollowed(address(leader));
    }

    /// @notice Lets the owner tighten limits at any time (risk can only go down without a new follow).
    function tighten(FollowParams calldata p) external onlyOwner {
        FollowParams memory c = _params;
        if (
            p.ratioBps > c.ratioBps || p.maxNotionalCNS > c.maxNotionalCNS || p.maxLeverageHdths > c.maxLeverageHdths
                || p.maxChaseBps > c.maxChaseBps || p.priceBandBps > c.priceBandBps || (p.marketsMask & ~c.marketsMask) != 0
                || p.ratioBps == 0 || p.priceBandBps == 0
        ) revert CopasErrors.BadParams();
        _params = p;
    }

    /// @notice Re-consents to the leader's live mandate, or pre-accepts its pending one (effective next epoch).
    function acceptMandate(Mandate calldata m) external onlyOwner {
        if (!following) revert CopasErrors.BadParams();
        bytes32 h = keccak256(abi.encode(m));
        if (
            h != keccak256(abi.encode(leader.mandate()))
                && !(leader.hasPendingMandate() && h == keccak256(abi.encode(leader.pendingMandate())))
        ) revert CopasErrors.BadParams();
        _accepted = m;
        emit MandateAccepted(address(leader), m);
    }

    /// @dev ponytail: epochLen is not compared; follower caps already bound leverage/notional/markets per trade,
    /// this guards the terms only the leader controls (fee, breach threshold) plus the rest for clarity.
    function _within(Mandate memory m, Mandate memory a) internal pure returns (bool) {
        return m.feeBps <= a.feeBps && m.maxDDbps <= a.maxDDbps && m.maxLeverageHdths <= a.maxLeverageHdths
            && m.maxNotionalCNS <= a.maxNotionalCNS && (m.marketsMask & ~a.marketsMask) == 0;
    }

    // ================================================================ sync

    /// @notice Permissionless. Moves this vault's position in `perpId` toward its target and returns
    /// the target lot. Never opens anything the leader does not hold right now.
    function sync(uint256 perpId) external returns (int256 target) {
        if (address(leader) == address(0)) revert CopasErrors.BadParams();
        if (following) _touchEpoch();

        uint256 idx = registry.indexOf(perpId);
        if (idx == type(uint256).max) revert CopasErrors.MarketNotAllowed();
        PerplLib.Market memory m = registry.market(idx);

        (int256 lLot,, uint256 lEntry,) = exchange.position(perpId, leader.accountId());
        (int256 fLot, uint256 mark,, bool ok) = exchange.position(perpId, accountId);
        if (!ok || mark == 0) revert CopasErrors.InvalidMark();

        target = _target(perpId, idx, m, lLot, mark);
        emit Synced(perpId, lLot, fLot, target, mark);
        if (target == fLot) return target;

        FollowParams memory p = _params;
        // reduce / flip first
        if (fLot != 0 && (target == 0 || (target > 0) != (fLot > 0) || _abs(target) < _abs(fLot))) {
            uint256 cut = (target == 0 || (target > 0) != (fLot > 0)) ? _abs(fLot) : _abs(fLot) - _abs(target);
            if (fLot > 0) {
                exchange.execOrder(PerplLib.ioc(perpId, PerplLib.CLOSE_LONG, _down(mark, p.priceBandBps), cut, 100));
            } else {
                exchange.execOrder(PerplLib.ioc(perpId, PerplLib.CLOSE_SHORT, _up(mark, p.priceBandBps), cut, 100));
            }
            if (_abs(target) <= _abs(fLot) && (target == 0 || (target > 0) == (fLot > 0))) return target;
            fLot = 0;
        }
        // add toward target
        uint256 add = _abs(target) - _abs(fLot);
        if (add == 0) return target;
        if (lEntry > 0) {
            uint256 diff = mark > lEntry ? mark - lEntry : lEntry - mark;
            if (diff * 10_000 / lEntry > p.maxChaseBps) {
                emit SkippedChase(perpId, mark, lEntry);
                return fLot;
            }
        }
        uint256 lev = p.maxLeverageHdths;
        uint256 lLev = leader.mandate().maxLeverageHdths;
        if (lLev < lev) lev = lLev;
        if (target > 0) {
            exchange.execOrder(PerplLib.ioc(perpId, PerplLib.OPEN_LONG, _up(mark, p.priceBandBps), add, lev));
        } else {
            exchange.execOrder(PerplLib.ioc(perpId, PerplLib.OPEN_SHORT, _down(mark, p.priceBandBps), add, lev));
        }
    }

    function _target(uint256 perpId, uint256 idx, PerplLib.Market memory m, int256 lLot, uint256 mark)
        internal
        returns (int256)
    {
        perpId;
        if (!following || paused || leader.status() != LeaderStatus.Active || !consentOk()) return 0;
        if ((_params.marketsMask >> idx) & 1 == 0) return 0;
        if (_stopLossHit()) return 0;
        if (lLot == 0) return 0;
        uint256 want = _abs(lLot) * _params.ratioBps / 10_000;
        uint256 cap = PerplLib.lotsFor(m, _params.maxNotionalCNS, mark);
        if (want > cap) want = cap;
        return lLot > 0 ? int256(want) : -int256(want);
    }

    function _stopLossHit() internal returns (bool) {
        if (_params.stopLossBps == 0) return false;
        int256 b = int256(startEquity[epochSeen]) + netFlow[epochSeen];
        if (b <= 0) return false;
        (uint256 eq, bool valid) = equity();
        if (!valid) return false;
        if (eq * 10_000 < uint256(b) * (10_000 - _params.stopLossBps)) {
            paused = true;
            emit StopLoss(epochSeen, eq, uint256(b));
            return true;
        }
        return false;
    }

    // ================================================================ epochs, fees, claims

    /// @notice Anyone can call; keeper calls it right after the leader rolls an epoch.
    function touch() external {
        if (following) _touchEpoch();
    }

    function _touchEpoch() internal {
        uint256 e = leader.epoch();
        if (e == epochSeen) return;
        (uint256 eq, bool valid) = equity();
        if (!valid) return;
        if (epochSeen != 0) endEquity[epochSeen] = eq;

        // performance fee on profit above the high-water mark, paid into the leader's slashable escrow
        uint256 feeBps = leader.mandate().feeBps;
        if (feeBps > _accepted.feeBps) feeBps = _accepted.feeBps;
        if (epochSeen != 0 && feeBps > 0 && eq > highWaterMark && !leader.breached(epochSeen)) {
            uint256 fee = (eq - highWaterMark) * feeBps / 10_000;
            try exchange.withdrawCollateral(fee) {
                uint256 toProtocol = fee * registry.protocolFeeBps() / 10_000;
                uint256 toRef = referrer == address(0) ? 0 : toProtocol * registry.referralShareBps() / 10_000;
                if (toRef > 0) {
                    ausd.transfer(referrer, toRef);
                    emit ReferralPaid(referrer, toRef);
                }
                if (toProtocol > toRef) ausd.transfer(registry.reserve(), toProtocol - toRef);
                ausd.approve(address(leader), fee - toProtocol);
                leader.depositFee(fee - toProtocol);
                eq -= fee;
                emit FeePaid(epochSeen, fee - toProtocol, toProtocol);
            } catch {}
        }
        if (eq > highWaterMark) highWaterMark = eq;

        epochSeen = e;
        startEquity[e] = eq;
        paused = false;
    }

    /// @notice Claims this vault's share of a slashed bond for epoch e. Paid straight to the owner.
    function claim(LeaderBook lb, uint256 e) external returns (uint256 amount) {
        if (address(lb) == address(leader) && following) _touchEpoch();
        uint256 loss = address(lb) == address(leader) ? lossIn(e) : 0;
        if (loss == 0) revert CopasErrors.NothingToClaim();
        amount = lb.claimFor(e, loss, owner);
        emit ClaimedSlash(e, loss, amount);
    }

    // ================================================================ utils

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _up(uint256 p, uint256 bps) internal pure returns (uint256) {
        return p * (10_000 + bps) / 10_000;
    }

    function _down(uint256 p, uint256 bps) internal pure returns (uint256) {
        return p * (10_000 - bps) / 10_000;
    }
}
