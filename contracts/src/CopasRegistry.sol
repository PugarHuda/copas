// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange, IERC20Min} from "./interfaces/IPerplExchange.sol";
import {PerplLib} from "./lib/PerplLib.sol";
import {Mandate, CopasErrors} from "./CopasTypes.sol";

interface ILeaderFactory {
    function deploy(address owner, Mandate calldata m) external returns (address leaderBook, address pool);
}

interface IVaultFactory {
    function deploy(address owner) external returns (address vault);
}

/// @notice Global config + factory front door. Knows which LeaderBooks and FollowerVaults are genuine.
contract CopasRegistry {
    IPerplExchange public immutable exchange;
    IERC20Min public immutable ausd;

    address public admin;
    address public reserve;
    ILeaderFactory public leaderFactory;
    IVaultFactory public vaultFactory;

    // risk parameters (see docs/SPEC.md §3)
    uint256 public maxVaultDepositCNS = 100e6; // ponytail: mainnet cap until audited
    uint256 public minBondAbsCNS = 25e6;
    uint256 public bondRatioBps = 1_000; // min bond = 10% of follower AUM
    uint256 public kEquity = 3; // follower AUM <= kEquity * leader equity
    uint256 public protocolFeeBps = 1_000; // protocol share of performance fees
    uint256 public uwFeeShareBps = 3_000; // underwriter share of released leader fees
    uint256 public claimWindowEpochs = 2;
    uint256 public unbondDelayEpochs = 1;
    uint64 public minEpochLen = 1 hours;

    PerplLib.Market[] internal _markets;

    mapping(address => bool) public isLeaderBook;
    mapping(address => bool) public isVault;
    address[] public leaderBooks;
    mapping(address => address[]) internal _vaultsOf;
    mapping(address => address[]) internal _leadersOf;

    event LeaderCreated(address indexed owner, address leaderBook, address pool);
    event VaultCreated(address indexed owner, address vault);
    event MarketSet(uint256 index, uint32 perpId, uint8 priceDecimals, uint8 lotDecimals);
    event ParamsUpdated();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert CopasErrors.NotOwner();
        _;
    }

    constructor(IPerplExchange _exchange, IERC20Min _ausd, address _reserve) {
        exchange = _exchange;
        ausd = _ausd;
        admin = msg.sender;
        reserve = _reserve;
    }

    // ---------------------------------------------------------------- admin

    function setFactories(ILeaderFactory lf, IVaultFactory vf) external onlyAdmin {
        leaderFactory = lf;
        vaultFactory = vf;
    }

    function addMarket(uint32 perpId, uint8 priceDecimals, uint8 lotDecimals) external onlyAdmin {
        _markets.push(PerplLib.Market(perpId, priceDecimals, lotDecimals));
        emit MarketSet(_markets.length - 1, perpId, priceDecimals, lotDecimals);
    }

    function setParams(
        uint256 _maxVaultDeposit,
        uint256 _minBondAbs,
        uint256 _bondRatioBps,
        uint256 _kEquity,
        uint256 _protocolFeeBps,
        uint256 _uwFeeShareBps,
        uint64 _minEpochLen
    ) external onlyAdmin {
        if (_protocolFeeBps > 5_000 || _uwFeeShareBps > 10_000 || _bondRatioBps > 10_000) revert CopasErrors.BadParams();
        maxVaultDepositCNS = _maxVaultDeposit;
        minBondAbsCNS = _minBondAbs;
        bondRatioBps = _bondRatioBps;
        kEquity = _kEquity;
        protocolFeeBps = _protocolFeeBps;
        uwFeeShareBps = _uwFeeShareBps;
        minEpochLen = _minEpochLen;
        emit ParamsUpdated();
    }

    function setAdmin(address a) external onlyAdmin {
        admin = a;
    }

    function setReserve(address r) external onlyAdmin {
        reserve = r;
    }

    // ---------------------------------------------------------------- factory

    function createLeader(Mandate calldata m) external returns (address lb, address pool) {
        (lb, pool) = leaderFactory.deploy(msg.sender, m);
        isLeaderBook[lb] = true;
        leaderBooks.push(lb);
        _leadersOf[msg.sender].push(lb);
        emit LeaderCreated(msg.sender, lb, pool);
    }

    function createVault() external returns (address v) {
        v = vaultFactory.deploy(msg.sender);
        isVault[v] = true;
        _vaultsOf[msg.sender].push(v);
        emit VaultCreated(msg.sender, v);
    }

    // ---------------------------------------------------------------- views

    function markets() external view returns (PerplLib.Market[] memory) {
        return _markets;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function market(uint256 i) external view returns (PerplLib.Market memory) {
        return _markets[i];
    }

    /// @return index of perpId in the market list, or type(uint256).max
    function indexOf(uint256 perpId) public view returns (uint256) {
        for (uint256 i; i < _markets.length; i++) {
            if (_markets[i].perpId == perpId) return i;
        }
        return type(uint256).max;
    }

    function leaderCount() external view returns (uint256) {
        return leaderBooks.length;
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function leadersOf(address owner) external view returns (address[] memory) {
        return _leadersOf[owner];
    }
}
