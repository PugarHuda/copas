// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange, IERC20Min} from "./interfaces/IPerplExchange.sol";
import {PerplLib} from "./lib/PerplLib.sol";
import {Mandate, LeaderStatus, BreachReason, CopasErrors} from "./CopasTypes.sol";
import {CopasRegistry} from "./CopasRegistry.sol";
import {UnderwriterPool} from "./UnderwriterPool.sol";

/// @notice Holds one leader's Perpl account, bond and mandate. Measures drawdown on a unit price so
/// the leader's own deposits/withdrawals can't hide losses. Anyone can checkpoint; a broken mandate
/// slashes the bond (+ unreleased fees + underwriters) into a pot that followers claim against.
contract LeaderBook {
    using PerplLib for IPerplExchange;

    struct Breach {
        BreachReason reason;
        uint64 atBlock;
        uint256 pot; // slashed AUSD available to followers of this epoch
        uint256 capTotal; // sum of eligible follower caps for this epoch
        uint256 claimed;
        bool swept;
    }

    CopasRegistry public immutable registry;
    IPerplExchange public immutable exchange;
    IERC20Min public immutable ausd;
    address public immutable owner;

    UnderwriterPool public pool;
    address public operator; // trader key: human or AI agent
    uint256 public accountId; // Perpl account held by this contract

    Mandate internal _mandate;
    Mandate internal _pendingMandate;
    bool public hasPendingMandate;

    LeaderStatus public status = LeaderStatus.Unbonded;
    uint256 public units;
    uint256 public epoch; // 0 = not started
    uint64 public epochStart;
    uint64 public epochEnd;
    uint256 public peakUnitPrice;
    uint256 public lastUnitPrice;

    uint256 public bond;
    uint256 public feeEscrow; // fees earned this epoch, slashable
    uint256 public feeClaimable;
    uint256 public unbondAmount;
    uint256 public unbondEpoch;
    uint256 public pendingWithdrawUnits;

    // followers
    uint256 public capTotalNext; // current registered exposure (AUM)
    mapping(uint256 => uint256) public epochCapTotal;
    mapping(address => uint256) public capOf;
    mapping(address => uint256) public fromEpoch; // first eligible epoch
    mapping(address => uint256) public untilEpoch; // last eligible epoch (0 = still following)

    mapping(uint256 => Breach) internal _breaches;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event Deposited(uint256 amount, uint256 unitsMinted, uint256 unitPrice);
    event WithdrawRequested(uint256 units);
    event Withdrawn(uint256 amount, uint256 unitsBurned);
    event BondPosted(uint256 amount, uint256 bond);
    event UnbondRequested(uint256 amount, uint256 unlockEpoch);
    event Unbonded(uint256 amount);
    event MandateDeclared(Mandate m, uint256 effectiveEpoch);
    event OperatorSet(address operator);
    event Traded(uint256 perpId, uint8 orderType, uint256 lot, uint256 price, uint256 orderId);
    event Checkpoint(uint256 indexed epoch, uint256 equity, uint256 unitPrice, uint256 peak, uint256 ddBps, uint256 leverageHdths);
    event Breached(uint256 indexed epoch, BreachReason reason, uint256 pot, uint256 capTotal);
    event EpochRolled(uint256 indexed epoch, uint64 start, uint64 end, uint256 unitPrice, LeaderStatus status);
    event FollowerRegistered(address indexed vault, uint256 cap, uint256 fromEpoch);
    event FollowerUnregistered(address indexed vault, uint256 untilEpoch);
    event Claimed(uint256 indexed epoch, address indexed vault, address to, uint256 amount);
    event Swept(uint256 indexed epoch, uint256 amount);
    event FeeDeposited(address indexed vault, uint256 amount);
    event FeesReleased(uint256 indexed epoch, uint256 toLeader, uint256 toUnderwriters);

    modifier onlyOwner() {
        if (msg.sender != owner) revert CopasErrors.NotOwner();
        _;
    }

    modifier onlyVault() {
        if (!registry.isVault(msg.sender)) revert CopasErrors.NotVault();
        _;
    }

    constructor(CopasRegistry _registry, address _owner, Mandate memory m) {
        registry = _registry;
        exchange = _registry.exchange();
        ausd = _registry.ausd();
        owner = _owner;
        operator = _owner;
        _validate(m);
        _mandate = m;
    }

    /// @dev Called once by the factory right after deployment.
    function setPool(UnderwriterPool p) external {
        if (address(pool) != address(0) || msg.sender != address(registry.leaderFactory())) revert CopasErrors.NotRegistry();
        pool = p;
    }

    // ================================================================ views

    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    function pendingMandate() external view returns (Mandate memory) {
        return _pendingMandate;
    }

    function breachOf(uint256 e) external view returns (Breach memory) {
        return _breaches[e];
    }

    function breached(uint256 e) public view returns (bool) {
        return _breaches[e].reason != BreachReason.None;
    }

    function equity() public view returns (uint256 eq, bool valid) {
        return exchange.equity(accountId, registry.markets());
    }

    function unitPrice() public view returns (uint256 u, bool valid) {
        uint256 eq;
        (eq, valid) = equity();
        u = units == 0 ? 1e18 : eq * 1e18 / units;
    }

    function minBond() public view returns (uint256) {
        uint256 dyn = capTotalNext * registry.bondRatioBps() / 10_000;
        uint256 abs_ = registry.minBondAbsCNS();
        return dyn > abs_ ? dyn : abs_;
    }

    /// @notice Max total follower exposure this leader can accept now. The bond side is the inverse of
    /// `minBond`, so accepting followers can never push the leader below its own minimum bond.
    function capacity() public view returns (uint256) {
        (uint256 eq,) = equity();
        uint256 byEq = eq * registry.kEquity();
        uint256 ratio = registry.bondRatioBps();
        uint256 byBond = ratio == 0 ? type(uint256).max : bond * 10_000 / ratio;
        return byEq < byBond ? byEq : byBond;
    }

    /// @notice Bond + underwriters that stand behind followers, before any breach.
    function protection() external view returns (uint256) {
        return bond + feeEscrow + (address(pool) == address(0) ? 0 : pool.assets());
    }

    function isMarketAllowed(uint256 perpId) public view returns (bool ok, PerplLib.Market memory m) {
        uint256 i = registry.indexOf(perpId);
        if (i == type(uint256).max || (_mandate.marketsMask >> i) & 1 == 0) return (false, m);
        return (true, registry.market(i));
    }

    // ================================================================ owner capital

    function deposit(uint256 amount) external onlyOwner {
        uint256 u = 1e18;
        if (units > 0) {
            bool valid;
            (u, valid) = unitPrice();
            if (!valid || u == 0) revert CopasErrors.InvalidMark();
        }
        ausd.transferFrom(msg.sender, address(this), amount);
        if (accountId == 0) {
            ausd.approve(address(exchange), type(uint256).max);
            accountId = exchange.createAccount(amount);
        } else {
            exchange.depositCollateral(amount);
        }
        uint256 minted = amount * 1e18 / u;
        units += minted;
        emit Deposited(amount, minted, u);
    }

    /// @notice Executed at the next epoch roll, so capital can't leave mid-epoch.
    function requestWithdraw(uint256 unitsAmount) external onlyOwner {
        if (unitsAmount > units) revert CopasErrors.BadParams();
        pendingWithdrawUnits = unitsAmount;
        emit WithdrawRequested(unitsAmount);
        if (epoch == 0) _executeWithdraw();
    }

    function postBond(uint256 amount) external onlyOwner {
        ausd.transferFrom(msg.sender, address(this), amount);
        bond += amount;
        emit BondPosted(amount, bond);
    }

    /// @notice Bond stays slashable until unbondEpoch has started.
    function requestUnbond(uint256 amount) external onlyOwner {
        if (amount > bond) revert CopasErrors.BadParams();
        unbondAmount = amount;
        unbondEpoch = epoch + 1 + registry.unbondDelayEpochs();
        emit UnbondRequested(amount, unbondEpoch);
    }

    function declare(Mandate calldata m) external onlyOwner {
        _validate(m);
        if (epoch == 0) {
            _mandate = m;
            emit MandateDeclared(m, 0);
            return;
        }
        _pendingMandate = m;
        hasPendingMandate = true;
        emit MandateDeclared(m, epoch + 1);
    }

    function setOperator(address op) external onlyOwner {
        operator = op;
        emit OperatorSet(op);
    }

    function claimFees() external onlyOwner returns (uint256 amount) {
        amount = feeClaimable;
        feeClaimable = 0;
        ausd.transfer(owner, amount);
    }

    /// @notice Starts epoch 1 once funded and bonded.
    function start() external onlyOwner {
        if (epoch != 0 || accountId == 0) revert CopasErrors.BadParams();
        if (bond < minBond()) revert CopasErrors.NotActive();
        _openEpoch();
    }

    // ================================================================ trading

    /// @notice IOC only (ponytail: no resting orders, so no locked balance or cancel paths).
    function trade(uint256 perpId, uint8 orderType, uint256 lot, uint256 price, uint256 leverageHdths)
        external
        returns (uint256 orderId)
    {
        if (msg.sender != operator && msg.sender != owner) revert CopasErrors.NotOperator();
        if (orderType > PerplLib.CLOSE_SHORT || lot == 0) revert CopasErrors.BadParams();
        bool opening = orderType <= PerplLib.OPEN_SHORT;
        if (opening) {
            if (status != LeaderStatus.Active) revert CopasErrors.NotActive();
            (bool ok, PerplLib.Market memory m) = isMarketAllowed(perpId);
            if (!ok) revert CopasErrors.MarketNotAllowed();
            if (leverageHdths > _mandate.maxLeverageHdths) revert CopasErrors.MandateViolation(BreachReason.Leverage);
            (uint256 gross,) = exchange.grossNotional(accountId, registry.markets());
            if (gross + PerplLib.notional(m, lot, price) > _mandate.maxNotionalCNS) {
                revert CopasErrors.MandateViolation(BreachReason.Notional);
            }
        }
        orderId = exchange.execOrder(PerplLib.ioc(perpId, orderType, price, lot, leverageHdths)).orderId;
        emit Traded(perpId, orderType, lot, price, orderId);
        _checkpoint();
    }

    // ================================================================ checkpoint / breach

    /// @notice Anyone can call. Followers are paid by breaches, so they have a reason to call it.
    function checkpoint() external {
        _checkpoint();
    }

    function _checkpoint() internal {
        if (status != LeaderStatus.Active || epoch == 0) return;
        PerplLib.Market[] memory mk = registry.markets();
        (uint256 eq, bool valid) = exchange.equity(accountId, mk);
        if (!valid) return;
        (uint256 gross, bool gValid) = exchange.grossNotional(accountId, mk);
        if (!gValid) return;
        uint256 u = units == 0 ? 1e18 : eq * 1e18 / units;
        lastUnitPrice = u;
        if (u > peakUnitPrice) peakUnitPrice = u;
        uint256 dd = peakUnitPrice == 0 ? 0 : (peakUnitPrice - u) * 10_000 / peakUnitPrice;
        uint256 lev = eq == 0 ? type(uint256).max : gross * 100 / eq;
        emit Checkpoint(epoch, eq, u, peakUnitPrice, dd, lev);

        if (dd > _mandate.maxDDbps) _breach(BreachReason.Drawdown);
        else if (gross > 0 && lev > _mandate.maxLeverageHdths) _breach(BreachReason.Leverage);
    }

    function _breach(BreachReason reason) internal {
        status = LeaderStatus.Breached;
        uint256 pot = bond + feeEscrow;
        bond = 0;
        feeEscrow = 0;
        unbondAmount = 0;
        if (address(pool) != address(0)) pot += pool.slash(type(uint256).max);
        Breach storage b = _breaches[epoch];
        b.reason = reason;
        b.atBlock = uint64(block.number);
        b.pot = pot;
        b.capTotal = epochCapTotal[epoch];
        emit Breached(epoch, reason, pot, b.capTotal);
    }

    // ================================================================ epochs

    function rollEpoch() external {
        if (epoch == 0 || block.timestamp < epochEnd) revert CopasErrors.EpochRunning();
        uint256 e = epoch;

        if (!breached(e)) {
            _checkpoint(); // last look before releasing anything
        }
        if (!breached(e) && feeEscrow > 0) {
            uint256 fees = feeEscrow;
            feeEscrow = 0;
            uint256 toUw = address(pool) != address(0) && pool.totalShares() > 0 ? fees * registry.uwFeeShareBps() / 10_000 : 0;
            if (toUw > 0) {
                ausd.transfer(address(pool), toUw);
                pool.notifyFee(toUw);
            }
            feeClaimable += fees - toUw;
            emit FeesReleased(e, fees - toUw, toUw);
        }
        if (unbondAmount > 0 && e + 1 >= unbondEpoch) {
            uint256 amt = unbondAmount > bond ? bond : unbondAmount;
            unbondAmount = 0;
            bond -= amt;
            ausd.transfer(owner, amt);
            emit Unbonded(amt);
        }
        if (pendingWithdrawUnits > 0) _executeWithdraw();
        if (hasPendingMandate) {
            _mandate = _pendingMandate;
            hasPendingMandate = false;
        }
        _openEpoch();
    }

    function _openEpoch() internal {
        (uint256 u, bool valid) = unitPrice();
        if (!valid) revert CopasErrors.InvalidMark();
        epoch += 1;
        epochStart = uint64(block.timestamp);
        epochEnd = uint64(block.timestamp) + _mandate.epochLen;
        peakUnitPrice = u;
        lastUnitPrice = u;
        epochCapTotal[epoch] = capTotalNext;
        status = bond >= minBond() ? LeaderStatus.Active : LeaderStatus.Unbonded;
        emit EpochRolled(epoch, epochStart, epochEnd, u, status);
    }

    function _executeWithdraw() internal {
        uint256 w = pendingWithdrawUnits;
        (uint256 eq, bool valid) = equity();
        if (!valid || units == 0) return;
        uint256 amount = eq * w / units;
        try exchange.withdrawCollateral(amount) {
            units -= w;
            pendingWithdrawUnits = 0;
            ausd.transfer(owner, amount);
            emit Withdrawn(amount, w);
        } catch {
            // free balance locked in positions: stays pending until the leader reduces exposure
        }
    }

    // ================================================================ followers

    function registerFollower(uint256 cap) external onlyVault {
        if (status != LeaderStatus.Active) revert CopasErrors.NotActive();
        if (capTotalNext + cap > capacity()) revert CopasErrors.CapacityExceeded();
        capTotalNext += cap;
        capOf[msg.sender] = cap;
        fromEpoch[msg.sender] = epoch + 1;
        untilEpoch[msg.sender] = 0;
        emit FollowerRegistered(msg.sender, cap, epoch + 1);
    }

    function unregisterFollower() external onlyVault {
        uint256 cap = capOf[msg.sender];
        capTotalNext -= cap;
        untilEpoch[msg.sender] = epoch;
        emit FollowerUnregistered(msg.sender, epoch);
    }

    function eligible(address vault, uint256 e) public view returns (bool) {
        uint256 f = fromEpoch[vault];
        uint256 u = untilEpoch[vault];
        return f != 0 && f <= e && (u == 0 || u >= e);
    }

    /// @notice Pro-rata share of epoch e's pot for `vault`, capped by its real loss (reported by the vault).
    function claimFor(uint256 e, uint256 loss, address to) external onlyVault returns (uint256 amount) {
        Breach storage b = _breaches[e];
        if (b.reason == BreachReason.None || b.swept) revert CopasErrors.NothingToClaim();
        if (epoch > e + registry.claimWindowEpochs()) revert CopasErrors.TooEarly();
        if (!eligible(msg.sender, e)) revert CopasErrors.NotVault();
        if (claimed[e][msg.sender]) revert CopasErrors.AlreadyClaimed();
        claimed[e][msg.sender] = true;
        uint256 share = b.capTotal == 0 ? 0 : b.pot * capOf[msg.sender] / b.capTotal;
        amount = share < loss ? share : loss;
        if (amount > b.pot - b.claimed) amount = b.pot - b.claimed;
        b.claimed += amount;
        if (amount > 0) ausd.transfer(to, amount);
        emit Claimed(e, msg.sender, to, amount);
    }

    /// @notice After the claim window, unclaimed pot goes to the protocol reserve.
    function sweep(uint256 e) external {
        Breach storage b = _breaches[e];
        if (b.reason == BreachReason.None || b.swept) revert CopasErrors.NothingToClaim();
        if (epoch <= e + registry.claimWindowEpochs()) revert CopasErrors.TooEarly();
        b.swept = true;
        uint256 rest = b.pot - b.claimed;
        if (rest > 0) ausd.transfer(registry.reserve(), rest);
        emit Swept(e, rest);
    }

    /// @notice Performance fee pushed by a follower vault; held in escrow and slashable this epoch.
    function depositFee(uint256 amount) external onlyVault {
        ausd.transferFrom(msg.sender, address(this), amount);
        feeEscrow += amount;
        emit FeeDeposited(msg.sender, amount);
    }

    // ================================================================ internal

    function _validate(Mandate memory m) internal view {
        if (
            m.maxDDbps == 0 || m.maxDDbps > 9_000 || m.maxLeverageHdths < 100 || m.maxLeverageHdths > 5_000
                || m.feeBps > 3_000 || m.epochLen < registry.minEpochLen() || m.maxNotionalCNS == 0 || m.marketsMask == 0
        ) revert CopasErrors.BadParams();
    }
}
