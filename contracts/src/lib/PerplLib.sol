// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange} from "../interfaces/IPerplExchange.sol";

/// @notice Read helpers over Perpl state. Everything Copas decides about money comes from here,
/// read in the same block, with no oracle.
library PerplLib {
    uint8 internal constant OPEN_LONG = 0;
    uint8 internal constant OPEN_SHORT = 1;
    uint8 internal constant CLOSE_LONG = 2;
    uint8 internal constant CLOSE_SHORT = 3;

    struct Market {
        uint32 perpId;
        uint8 priceDecimals;
        uint8 lotDecimals;
    }

    /// @return eq account equity in CNS (AUSD, 6 decimals), floored at 0
    /// @return valid false if any open position has an invalid mark price
    function equity(IPerplExchange ex, uint256 acct, Market[] memory markets)
        internal
        view
        returns (uint256 eq, bool valid)
    {
        if (acct == 0) return (0, true);
        int256 e = int256(ex.getAccountById(acct).balanceCNS);
        valid = true;
        for (uint256 i; i < markets.length; i++) {
            (IPerplExchange.PositionInfo memory p,, bool ok) = ex.getPosition(markets[i].perpId, acct);
            if (p.lotLNS == 0) continue;
            if (!ok) valid = false;
            e += int256(p.depositCNS) + p.pnlCNS;
        }
        eq = e > 0 ? uint256(e) : 0;
    }

    /// @return lot signed lot (long > 0, short < 0)
    /// @return mark mark price PNS
    /// @return entry entry price PNS
    /// @return ok mark validity
    function position(IPerplExchange ex, uint256 perpId, uint256 acct)
        internal
        view
        returns (int256 lot, uint256 mark, uint256 entry, bool ok)
    {
        if (acct == 0) {
            IPerplExchange.PositionInfo memory none;
            (none, mark, ok) = ex.getPosition(perpId, 1);
            return (0, mark, 0, ok);
        }
        IPerplExchange.PositionInfo memory p;
        (p, mark, ok) = ex.getPosition(perpId, acct);
        entry = p.pricePNS;
        lot = p.positionType == 0 ? int256(p.lotLNS) : -int256(p.lotLNS);
    }

    /// @notice notional in CNS (6 decimals) of `lot` at `price`.
    function notional(Market memory m, uint256 lot, uint256 price) internal pure returns (uint256) {
        return lot * price * 1e6 / (10 ** (uint256(m.priceDecimals) + m.lotDecimals));
    }

    /// @notice lots that fit in `notionalCNS` at `price`.
    function lotsFor(Market memory m, uint256 notionalCNS, uint256 price) internal pure returns (uint256) {
        if (price == 0) return 0;
        return notionalCNS * (10 ** (uint256(m.priceDecimals) + m.lotDecimals)) / (price * 1e6);
    }

    /// @notice Gross notional of all positions and whether every mark was valid.
    function grossNotional(IPerplExchange ex, uint256 acct, Market[] memory markets)
        internal
        view
        returns (uint256 gross, bool valid)
    {
        valid = true;
        if (acct == 0) return (0, true);
        for (uint256 i; i < markets.length; i++) {
            (IPerplExchange.PositionInfo memory p, uint256 mark, bool ok) = ex.getPosition(markets[i].perpId, acct);
            if (p.lotLNS == 0) continue;
            if (!ok) valid = false;
            gross += notional(markets[i], p.lotLNS, mark);
        }
    }

    function ioc(uint256 perpId, uint8 orderType, uint256 price, uint256 lot, uint256 leverageHdths)
        internal
        view
        returns (IPerplExchange.OrderDesc memory o)
    {
        o.perpId = perpId;
        o.orderType = orderType;
        o.pricePNS = price;
        o.lotLNS = lot;
        o.expiryBlock = block.number + 20;
        o.immediateOrCancel = true;
        o.leverageHdths = leverageHdths;
        // Perpl's market default; 0 refuses any fill that must collateralize negative PnL vs mark (most shorts)
        o.maxNegPnlCollatBPS = 1000;
    }
}
