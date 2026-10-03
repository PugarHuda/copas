// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min} from "./interfaces/IPerplExchange.sol";
import {CopasRegistry} from "./CopasRegistry.sol";
import {LeaderBook} from "./LeaderBook.sol";
import {CopasErrors} from "./CopasTypes.sol";

/// @notice Minimal ERC-20 for one side of one series. Mint/burn only by the market.
contract BreachToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    address public immutable market;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
        market = msg.sender;
    }

    function mint(address to, uint256 a) external {
        if (msg.sender != market) revert CopasErrors.NotRegistry();
        totalSupply += a;
        balanceOf[to] += a;
        emit Transfer(address(0), to, a);
    }

    function burn(address from, uint256 a) external {
        if (msg.sender != market) revert CopasErrors.NotRegistry();
        balanceOf[from] -= a;
        totalSupply -= a;
        emit Transfer(from, address(0), a);
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        emit Transfer(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        emit Transfer(f, to, a);
        return true;
    }
}

/// @notice Fully collateralised UP/DOWN pair on "does this leader breach its mandate in epoch e".
/// 1 AUSD mints 1 UP + 1 DOWN. After the epoch ends, the winning side redeems 1 AUSD; the loser 0.
/// Settles from LeaderBook state only: no oracle, always solvent. DOWN's market price is the market's
/// probability that the leader blows up (a CDS on a trader). Trade DOWN on a Kuru order book.
contract BreachMarket {
    struct Series {
        BreachToken up;
        BreachToken down;
        bool settled;
        bool breach;
    }

    CopasRegistry public immutable registry;
    IERC20Min public immutable ausd;
    mapping(address => mapping(uint256 => Series)) internal _series;

    event SeriesCreated(address indexed leaderBook, uint256 indexed epoch, address up, address down);
    event Minted(address indexed leaderBook, uint256 indexed epoch, address to, uint256 amount);
    event PairRedeemed(address indexed leaderBook, uint256 indexed epoch, address to, uint256 amount);
    event Settled(address indexed leaderBook, uint256 indexed epoch, bool breach);
    event Redeemed(address indexed leaderBook, uint256 indexed epoch, address to, uint256 amount);

    constructor(CopasRegistry r) {
        registry = r;
        ausd = r.ausd();
    }

    function series(address lb, uint256 e) external view returns (Series memory) {
        return _series[lb][e];
    }

    function mint(LeaderBook lb, uint256 e, uint256 amount, address to) external {
        if (!registry.isLeaderBook(address(lb))) revert CopasErrors.NotLeader();
        if (e < lb.epoch() || e > lb.epoch() + 1 || e == 0) revert CopasErrors.BadParams();
        Series storage s = _series[address(lb)][e];
        if (address(s.up) == address(0)) {
            string memory tag = string.concat(_hex(address(lb)), "-E", _u(e));
            s.up = new BreachToken(string.concat("Copas UP ", tag), "cUP");
            s.down = new BreachToken(string.concat("Copas DOWN ", tag), "cDOWN");
            emit SeriesCreated(address(lb), e, address(s.up), address(s.down));
        }
        if (s.settled) revert CopasErrors.BadParams();
        ausd.transferFrom(msg.sender, address(this), amount);
        s.up.mint(to, amount);
        s.down.mint(to, amount);
        emit Minted(address(lb), e, to, amount);
    }

    /// @notice Before settlement, a full pair always redeems 1:1.
    function redeemPair(LeaderBook lb, uint256 e, uint256 amount) external {
        Series storage s = _series[address(lb)][e];
        s.up.burn(msg.sender, amount);
        s.down.burn(msg.sender, amount);
        ausd.transfer(msg.sender, amount);
        emit PairRedeemed(address(lb), e, msg.sender, amount);
    }

    /// @notice Settles as soon as a breach happens, or as NO-BREACH once the epoch has rolled.
    function settle(LeaderBook lb, uint256 e) public {
        Series storage s = _series[address(lb)][e];
        if (address(s.up) == address(0) || s.settled) revert CopasErrors.BadParams();
        bool b = lb.breached(e);
        if (!b && lb.epoch() <= e) revert CopasErrors.EpochRunning();
        s.settled = true;
        s.breach = b;
        emit Settled(address(lb), e, b);
    }

    function redeem(LeaderBook lb, uint256 e, uint256 amount) external {
        Series storage s = _series[address(lb)][e];
        if (!s.settled) settle(lb, e);
        BreachToken win = s.breach ? s.down : s.up;
        win.burn(msg.sender, amount);
        ausd.transfer(msg.sender, amount);
        emit Redeemed(address(lb), e, msg.sender, amount);
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + v % 10)), b);
            v /= 10;
        }
        return string(b);
    }

    function _hex(address a) internal pure returns (string memory) {
        bytes memory s = new bytes(6);
        bytes16 sym = "0123456789abcdef";
        uint160 v = uint160(a) >> 136; // first 3 bytes
        for (uint256 i; i < 6; i++) {
            s[5 - i] = sym[v & 0xf];
            v >>= 4;
        }
        return string.concat("0x", string(s));
    }
}
