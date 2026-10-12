// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Untrusted storage for the encrypted leader strategy feed (SPEC E3, Mera "Many Keys").
/// Keys and plaintext never touch this contract: each account publishes an X25519 public key derived
/// from its passkey PRF (salt sha256("copas.feed.v1")), and leaders append opaque ciphertext blobs
/// whose content key is wrapped per reader in the browser.
contract CopasFeed {
    mapping(address => bytes32) public feedKey;
    mapping(address => bytes[]) internal _posts;

    event FeedKeySet(address indexed account, bytes32 key);
    event Posted(address indexed author, uint256 indexed index);

    function setFeedKey(bytes32 key) external {
        feedKey[msg.sender] = key;
        emit FeedKeySet(msg.sender, key);
    }

    function post(bytes calldata blob) external {
        require(blob.length > 0 && blob.length <= 16_384, "blob size");
        _posts[msg.sender].push(blob);
        emit Posted(msg.sender, _posts[msg.sender].length - 1);
    }

    function posts(address author) external view returns (bytes[] memory) {
        return _posts[author];
    }

    function feedKeys(address[] calldata accounts) external view returns (bytes32[] memory keys) {
        keys = new bytes32[](accounts.length);
        for (uint256 i; i < accounts.length; i++) keys[i] = feedKey[accounts[i]];
    }
}
