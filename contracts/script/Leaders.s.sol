// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry} from "../src/CopasRegistry.sol";
import {LeaderBook} from "../src/LeaderBook.sol";
import {FollowerVault} from "../src/FollowerVault.sol";
import {Mandate, FollowParams} from "../src/CopasTypes.sol";

/// Two more test leaders with different mandates (our own testnet accounts, not users), same flow as Seed.s.sol:
///   conservative (LEADER2_KEY): 5% DD, 3x, BTC+ETH, 10% fee; followers FOLLOWER2_KEY, FOLLOWER3_KEY; BTC long (+ ETH long if the book fills)
///   aggressive   (LEADER3_KEY): 30% DD, 10x, all markets, 20% fee; follower FOLLOWER4_KEY; BTC short at 5x (falls back to a 5x long when testnet Perpl rejects the short fill)
/// DEPLOYER_KEY tops up follower MON and everyone's AUSD (the Perpl faucet allows one claim per block). State in deployments/leaders-<chainId>.json.
/// First run creates everything and writes the state file; reruns only retry missing trades/copies.
/// forge script script/Leaders.s.sol --rpc-url $RPC --broadcast --slow
contract Leaders is Script {
    uint256 constant BTC = 16;
    uint256 constant ETH = 32;

    CopasRegistry reg;
    IPerplExchange ex;
    IERC20Min ausd;

    function run() external {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        reg = CopasRegistry(vm.parseJsonAddress(dep, ".registry"));
        ex = IPerplExchange(vm.parseJsonAddress(dep, ".exchange"));
        ausd = IERC20Min(vm.parseJsonAddress(dep, ".ausd"));
        uint256 f2 = vm.envUint("FOLLOWER2_KEY");
        uint256 f3 = vm.envUint("FOLLOWER3_KEY");
        uint256 f4 = vm.envUint("FOLLOWER4_KEY");
        string memory statePath = string.concat("deployments/leaders-", vm.toString(block.chainid), ".json");

        if (!vm.exists(statePath)) {
            vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
            for (uint256 i; i < 3; i++) {
                address f = vm.addr([f2, f3, f4][i]);
                if (f.balance < 0.6 ether) payable(f).transfer(0.65 ether - f.balance);
                if (ausd.balanceOf(f) < 100e6) ausd.transfer(f, 100e6);
            }
            for (uint256 i; i < 2; i++) {
                address l = vm.addr(vm.envUint(i == 0 ? "LEADER2_KEY" : "LEADER3_KEY"));
                if (ausd.balanceOf(l) < 150e6) ausd.transfer(l, 150e6);
            }
            vm.stopBroadcast();

            LeaderBook c = _leader(
                vm.envUint("LEADER2_KEY"),
                Mandate({
                    maxDDbps: 500,
                    maxLeverageHdths: 300,
                    feeBps: 1_000,
                    epochLen: 1 hours,
                    maxNotionalCNS: 500e6,
                    marketsMask: 0x3
                })
            );
            LeaderBook g = _leader(
                vm.envUint("LEADER3_KEY"),
                Mandate({
                    maxDDbps: 3_000,
                    maxLeverageHdths: 1_000,
                    feeBps: 2_000,
                    epochLen: 1 hours,
                    maxNotionalCNS: 2_000e6,
                    marketsMask: 0xF
                })
            );
            vm.serializeAddress("l", "conservative", address(c));
            vm.serializeAddress("l", "aggressive", address(g));
            vm.serializeAddress("l", "vaultConservativeA", address(_follower(f2, c, 10_000, 300, 100e6)));
            vm.serializeAddress("l", "vaultConservativeB", address(_follower(f3, c, 5_000, 200, 60e6)));
            vm.writeJson(
                vm.serializeAddress("l", "vaultAggressive", address(_follower(f4, g, 10_000, 1_000, 150e6))), statePath
            );
        }

        // trade phase: idempotent, rerun until every leader holds its position (testnet Perpl sometimes rejects a fill)
        string memory st = vm.readFile(statePath);
        LeaderBook cons = LeaderBook(vm.parseJsonAddress(st, ".conservative"));
        LeaderBook aggr = LeaderBook(vm.parseJsonAddress(st, ".aggressive"));
        _open(vm.envUint("LEADER2_KEY"), cons, BTC, 0, 40, 200); // 0.0004 BTC long, 2x
        _open(vm.envUint("LEADER2_KEY"), cons, ETH, 0, 5, 200); // 0.005 ETH long, 2x
        // 0.0006 BTC short at 5x; testnet Perpl has been rejecting short fills (custom error 0xb29d1949), so fall back to a 5x long
        if (!_open(vm.envUint("LEADER3_KEY"), aggr, BTC, 1, 60, 500)) {
            _open(vm.envUint("LEADER3_KEY"), aggr, BTC, 0, 60, 500);
        }

        // anyone may sync; each follower pays its own gas
        _sync(f2, FollowerVault(vm.parseJsonAddress(st, ".vaultConservativeA")), cons);
        _sync(f3, FollowerVault(vm.parseJsonAddress(st, ".vaultConservativeB")), cons);
        _sync(f4, FollowerVault(vm.parseJsonAddress(st, ".vaultAggressive")), aggr);
        console.log("conservative", address(cons), "aggressive", address(aggr));
    }

    function _lot(uint256 perp, uint256 acct) internal view returns (uint256) {
        (IPerplExchange.PositionInfo memory pos,,) = ex.getPosition(perp, acct);
        return pos.lotLNS;
    }

    /// @dev Dry-runs the order first (pranked, then rolled back): a reverting call inside vm.broadcast would still be broadcast.
    function _open(uint256 key, LeaderBook lb, uint256 perp, uint8 orderType, uint256 lot, uint256 lev)
        internal
        returns (bool ok)
    {
        if (_lot(perp, lb.accountId()) != 0) return true;
        IPerplExchange.PerpetualInfo memory i = ex.getPerpetualInfo(perp);
        uint256 px = orderType == 0
            ? (i.basePricePNS + i.minAskPriceONS) * 101 / 100
            : (i.basePricePNS + i.maxBidPriceONS) * 99 / 100;
        uint256 snap = vm.snapshotState();
        vm.prank(vm.addr(key));
        try lb.trade(perp, orderType, lot, px, lev) {
            ok = true;
        } catch {}
        vm.revertToState(snap);
        if (!ok) {
            console.log("no fill, rerun later: perp", perp, address(lb));
            return false;
        }
        vm.broadcast(key);
        lb.trade(perp, orderType, lot, px, lev);
    }

    function _sync(uint256 key, FollowerVault v, LeaderBook lb) internal {
        for (uint256 p = BTC; p <= ETH; p += 16) {
            if (_lot(p, lb.accountId()) == 0 || _lot(p, v.accountId()) != 0) continue; // nothing to copy / already copied
            uint256 snap = vm.snapshotState();
            bool ok;
            try v.sync(p) {
                ok = true;
            } catch {}
            vm.revertToState(snap);
            if (!ok) {
                console.log("sync failed, rerun later: perp", p, address(v));
                continue;
            }
            vm.broadcast(key);
            v.sync(p);
        }
    }

    function _leader(uint256 key, Mandate memory m) internal returns (LeaderBook lb) {
        vm.startBroadcast(key);
        (address a,) = reg.createLeader(m);
        lb = LeaderBook(a);
        ausd.approve(a, type(uint256).max);
        lb.deposit(100e6);
        lb.postBond(50e6);
        lb.start();
        vm.stopBroadcast();
    }

    function _follower(uint256 key, LeaderBook lb, uint32 ratioBps, uint32 maxLev, uint128 cap)
        internal
        returns (FollowerVault v)
    {
        vm.startBroadcast(key);
        v = FollowerVault(reg.createVault());
        ausd.approve(address(v), type(uint256).max);
        v.deposit(100e6); // testnet Perpl rejects accounts opened with less
        v.follow(
            lb,
            FollowParams({
                ratioBps: ratioBps,
                maxLeverageHdths: maxLev,
                maxChaseBps: 100,
                priceBandBps: 100,
                stopLossBps: 0,
                maxNotionalCNS: cap,
                marketsMask: 0xF
            })
        );
        vm.stopBroadcast();
    }
}
