// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";

contract MockAUSD {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @notice Minimal Perpl stand-in: IOC orders fill fully at the mark; pnl is mark-to-market.
contract MockPerpl {
    struct Pos {
        uint8 t; // 0 long 1 short
        uint256 lot;
        uint256 entry;
        uint256 deposit;
    }

    MockAUSD public immutable ausd;
    uint256 public nextId = 1;
    mapping(address => uint256) public idOf;
    mapping(uint256 => address) public addrOf;
    mapping(uint256 => uint256) public balance;
    mapping(uint256 => mapping(uint256 => Pos)) public pos;
    mapping(uint256 => uint256) public mark;
    mapping(uint256 => uint8) public priceDec;
    mapping(uint256 => uint8) public lotDec;
    mapping(uint256 => bool) public markInvalid;

    constructor(MockAUSD a) {
        ausd = a;
    }

    function setMarket(uint256 perpId, uint256 m, uint8 pd, uint8 ld) external {
        mark[perpId] = m;
        priceDec[perpId] = pd;
        lotDec[perpId] = ld;
    }

    function setMark(uint256 perpId, uint256 m) external {
        mark[perpId] = m;
    }

    function setMarkInvalid(uint256 perpId, bool v) external {
        markInvalid[perpId] = v;
    }

    function _notional(uint256 perpId, uint256 lot, uint256 price) internal view returns (uint256) {
        return lot * price * 1e6 / (10 ** (uint256(priceDec[perpId]) + lotDec[perpId]));
    }

    function _pnl(uint256 perpId, Pos memory p) internal view returns (int256) {
        if (p.lot == 0) return 0;
        int256 now_ = int256(_notional(perpId, p.lot, mark[perpId]));
        int256 then_ = int256(_notional(perpId, p.lot, p.entry));
        return p.t == 0 ? now_ - then_ : then_ - now_;
    }

    function createAccount(uint256 amt) external returns (uint256 id) {
        require(idOf[msg.sender] == 0, "exists");
        require(amt >= 10e6, "min");
        ausd.transferFrom(msg.sender, address(this), amt);
        id = nextId++;
        idOf[msg.sender] = id;
        addrOf[id] = msg.sender;
        balance[id] = amt;
    }

    function depositCollateral(uint256 amt) external {
        uint256 id = idOf[msg.sender];
        ausd.transferFrom(msg.sender, address(this), amt);
        balance[id] += amt;
    }

    function withdrawCollateral(uint256 amt) external {
        uint256 id = idOf[msg.sender];
        require(balance[id] >= amt, "free balance");
        balance[id] -= amt;
        ausd.transfer(msg.sender, amt);
    }

    function execOrder(IPerplExchange.OrderDesc calldata o) external returns (IPerplExchange.OrderSignature memory s) {
        uint256 id = idOf[msg.sender];
        require(id != 0, "no account");
        uint256 m = mark[o.perpId];
        Pos storage p = pos[o.perpId][id];
        if (o.orderType <= 1) {
            // IOC limit must cross the mark
            if (o.orderType == 0) require(o.pricePNS >= m, "limit");
            else require(o.pricePNS <= m, "limit");
            require(p.lot == 0 || p.t == o.orderType, "flip via close");
            uint256 dep = _notional(o.perpId, o.lotLNS, m) * 100 / o.leverageHdths;
            require(balance[id] >= dep, "margin");
            balance[id] -= dep;
            uint256 newLot = p.lot + o.lotLNS;
            p.entry = (p.entry * p.lot + m * o.lotLNS) / newLot;
            p.lot = newLot;
            p.t = o.orderType;
            p.deposit += dep;
        } else {
            require(p.lot >= o.lotLNS && p.t == o.orderType - 2, "close");
            if (o.orderType == 2) require(o.pricePNS <= m, "limit");
            else require(o.pricePNS >= m, "limit");
            int256 pnl = _pnl(o.perpId, p) * int256(o.lotLNS) / int256(p.lot);
            uint256 dep = p.deposit * o.lotLNS / p.lot;
            int256 back = int256(dep) + pnl;
            if (back > 0) balance[id] += uint256(back);
            p.deposit -= dep;
            p.lot -= o.lotLNS;
            if (p.lot == 0) delete pos[o.perpId][id];
        }
        s.perpId = o.perpId;
        s.orderId = 1;
    }

    function getAccountById(uint256 id) external view returns (IPerplExchange.AccountInfo memory a) {
        a.accountId = id;
        a.balanceCNS = balance[id];
        a.accountAddr = addrOf[id];
    }

    function getPosition(uint256 perpId, uint256 id)
        external
        view
        returns (IPerplExchange.PositionInfo memory info, uint256 markPricePNS, bool valid)
    {
        Pos memory p = pos[perpId][id];
        info.accountId = id;
        info.positionType = p.t;
        info.depositCNS = p.deposit;
        info.pricePNS = p.entry;
        info.lotLNS = p.lot;
        info.pnlCNS = _pnl(perpId, p);
        info.deltaPnlCNS = info.pnlCNS;
        markPricePNS = mark[perpId];
        valid = !markInvalid[perpId];
    }
}
