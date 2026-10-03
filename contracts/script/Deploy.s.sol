// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {IPerplExchange, IERC20Min} from "../src/interfaces/IPerplExchange.sol";
import {CopasRegistry, ILeaderFactory, IVaultFactory} from "../src/CopasRegistry.sol";
import {LeaderFactory, VaultFactory} from "../src/Factories.sol";
import {BreachMarket} from "../src/BreachMarket.sol";
import {AgentLeaderRegistry, IIdentityRegistry8004} from "../src/AgentLeaderRegistry.sol";

/// Deploy Copas.
///   Mainnet: PERPL_EXCHANGE=0x34B6552d57a35a1D042CcAe1951BD1C370112a6F PERP_IDS=1,20,31,10
///            IDENTITY_8004=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
///   Testnet: PERPL_EXCHANGE=0x1964C32f0bE608E7D29302AFF5E61268E72080cc PERP_IDS=16,32,48,64
///            IDENTITY_8004=0x8004A818BFB912233c491871b3d84c89A494BD9e
/// forge script script/Deploy.s.sol --rpc-url $RPC --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external {
        IPerplExchange ex = IPerplExchange(vm.envAddress("PERPL_EXCHANGE"));
        uint256[] memory perps = vm.envUint("PERP_IDS", ",");
        address identity = vm.envAddress("IDENTITY_8004");
        address reserve = vm.envOr("RESERVE", msg.sender);
        uint256 maxVault = vm.envOr("MAX_VAULT_DEPOSIT", uint256(100e6));
        uint256 minBond = vm.envOr("MIN_BOND", uint256(25e6));
        uint64 minEpoch = uint64(vm.envOr("MIN_EPOCH_SECONDS", uint256(1 hours)));

        (,,,, address collateral,) = IPerplExchangeInfo(address(ex)).getExchangeInfo();

        vm.startBroadcast();
        CopasRegistry reg = new CopasRegistry(ex, IERC20Min(collateral), reserve);
        LeaderFactory lf = new LeaderFactory(reg);
        VaultFactory vf = new VaultFactory(reg);
        reg.setFactories(ILeaderFactory(address(lf)), IVaultFactory(address(vf)));
        for (uint256 i; i < perps.length; i++) {
            IPerplExchange.PerpetualInfo memory info = ex.getPerpetualInfo(perps[i]);
            reg.addMarket(uint32(perps[i]), uint8(info.priceDecimals), uint8(info.lotDecimals));
        }
        reg.setParams(maxVault, minBond, 1_000, 3, 1_000, 3_000, minEpoch);
        BreachMarket bm = new BreachMarket(reg);
        AgentLeaderRegistry ar = new AgentLeaderRegistry(reg, IIdentityRegistry8004(identity));
        vm.stopBroadcast();

        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "block", block.number);
        vm.serializeAddress(k, "exchange", address(ex));
        vm.serializeAddress(k, "ausd", collateral);
        vm.serializeAddress(k, "registry", address(reg));
        vm.serializeAddress(k, "leaderFactory", address(lf));
        vm.serializeAddress(k, "vaultFactory", address(vf));
        vm.serializeAddress(k, "breachMarket", address(bm));
        vm.serializeAddress(k, "agentRegistry", address(ar));
        string memory json = vm.serializeAddress(k, "identity8004", identity);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}

interface IPerplExchangeInfo {
    function getExchangeInfo() external view returns (uint256, uint256, uint256, uint256, address, address);
}
