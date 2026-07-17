// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IOrgRegistry} from "./interfaces/IOrgRegistry.sol";

/// @title OrgRegistry
/// @notice Stores the organization tree for a single LaCrew org.
/// @dev Bootstrap: only `root` may mutate until `setGovernor` binds GovernanceModule.
contract OrgRegistry is IOrgRegistry {
    mapping(address => Node) private _nodes;
    mapping(address => address[]) private _children;

    address public root;
    /// @notice When non-zero, only this address may mutate the tree (GovernanceModule).
    address public governor;

    error NodeAlreadyExists(address account);
    error NodeNotFound(address account);
    error InvalidParent(address parent);
    error NotAuthorized(address caller);
    error GovernorAlreadySet();
    error ZeroAddress();

    constructor(address humanRoot) {
        if (humanRoot == address(0)) revert ZeroAddress();
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

    /// @notice Bind constitutional authority. Callable once by root (or current governor).
    function setGovernor(address governor_) external {
        if (governor_ == address(0)) revert ZeroAddress();
        if (governor != address(0)) {
            if (msg.sender != governor) revert NotAuthorized(msg.sender);
        } else if (msg.sender != root) {
            revert NotAuthorized(msg.sender);
        }
        governor = governor_;
    }

    /// @notice Add a child node under `parent`.
    function addNode(address account, NodeKind kind, address parent) external {
        _authorize();
        if (_nodes[account].account != address(0)) revert NodeAlreadyExists(account);
        if (_nodes[parent].account == address(0)) revert InvalidParent(parent);

        _nodes[account] = Node({account: account, kind: kind, parent: parent, active: true});
        _children[parent].push(account);
    }

    /// @notice Deactivate a node (fire). Children are not auto-rewired in v0.
    function setActive(address account, bool active) external {
        _authorize();
        if (_nodes[account].account == address(0)) revert NodeNotFound(account);
        _nodes[account].active = active;
    }

    function _authorize() private view {
        if (governor != address(0)) {
            if (msg.sender != governor) revert NotAuthorized(msg.sender);
        } else if (msg.sender != root) {
            revert NotAuthorized(msg.sender);
        }
    }
}
