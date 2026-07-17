// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IOrgRegistry} from "./interfaces/IOrgRegistry.sol";

/// @title OrgRegistry
/// @notice Stores the organization tree for a single LaCrew org.
/// @dev Mocked: in-memory mappings only; no governance gating yet.
contract OrgRegistry is IOrgRegistry {
    mapping(address => Node) private _nodes;
    mapping(address => address[]) private _children;

    address public root;

    error NodeAlreadyExists(address account);
    error NodeNotFound(address account);
    error InvalidParent(address parent);

    /// @notice Bootstrap a registry with a single human root.
    /// @dev Mocked: constructor sets root without GovernanceModule.
    /// TODO: Restrict structural mutations to GovernanceModule only.
    constructor(address humanRoot) {
        root = humanRoot;
        _nodes[humanRoot] = Node({
            account: humanRoot,
            kind: NodeKind.HumanRoot,
            parent: address(0),
            active: true
        });
    }

    /// @inheritdoc IOrgRegistry
    function getNode(address account) external view returns (Node memory node) {
        node = _nodes[account];
        if (node.account == address(0)) revert NodeNotFound(account);
    }

    /// @inheritdoc IOrgRegistry
    function getChildren(address parent) external view returns (address[] memory children) {
        return _children[parent];
    }

    /// @notice Add a child node under `parent`.
    /// @dev Mocked: permissionless for local scaffolding.
    /// TODO: Gate behind GovernanceModule constitutional proposal.
    function addNode(address account, NodeKind kind, address parent) external {
        if (_nodes[account].account != address(0)) revert NodeAlreadyExists(account);
        if (_nodes[parent].account == address(0)) revert InvalidParent(parent);

        _nodes[account] = Node({account: account, kind: kind, parent: parent, active: true});
        _children[parent].push(account);
    }
}
