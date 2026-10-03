// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Mandate, CopasErrors} from "./CopasTypes.sol";
import {CopasRegistry} from "./CopasRegistry.sol";
import {LeaderBook} from "./LeaderBook.sol";
import {FollowerVault} from "./FollowerVault.sol";
import {UnderwriterPool} from "./UnderwriterPool.sol";

/// @dev Factories are split from the registry to keep each contract's bytecode small.
contract LeaderFactory {
    CopasRegistry public immutable registry;

    constructor(CopasRegistry r) {
        registry = r;
    }

    function deploy(address owner, Mandate calldata m) external returns (address lb, address pool) {
        if (msg.sender != address(registry)) revert CopasErrors.NotRegistry();
        LeaderBook book = new LeaderBook(registry, owner, m);
        UnderwriterPool p = new UnderwriterPool(registry.ausd(), address(book));
        book.setPool(p);
        return (address(book), address(p));
    }
}

contract VaultFactory {
    CopasRegistry public immutable registry;

    constructor(CopasRegistry r) {
        registry = r;
    }

    function deploy(address owner) external returns (address) {
        if (msg.sender != address(registry)) revert CopasErrors.NotRegistry();
        return address(new FollowerVault(registry, owner));
    }
}
