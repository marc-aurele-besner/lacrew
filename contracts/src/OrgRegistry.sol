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

    event NodeAdded(address indexed account, NodeKind kind, address indexed parent);
    event NodeRemoved(address indexed account, address indexed formerParent);
    event NodeReparented(address indexed account, address indexed oldParent, address indexed newParent);
    event NodeActiveUpdated(address indexed account, bool active);

    error NodeAlreadyExists(address account);
    error NodeNotFound(address account);
    error InvalidParent(address parent);
    error CannotMutateRoot(address account);
    error CyclicParent(address account, address newParent);
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
        emit NodeAdded(account, kind, parent);
    }

    /// @notice Soft-deactivate a node without removing it from the tree.
    function setActive(address account, bool active) external {
        _authorize();
        if (_nodes[account].account == address(0)) revert NodeNotFound(account);
        if (account == root) revert CannotMutateRoot(account);
        _nodes[account].active = active;
        emit NodeActiveUpdated(account, active);
    }

    /// @notice Fire/remove a node. Children are rewired to the removed node's parent.
    function removeNode(address account) external {
        _authorize();
        Node memory node = _nodes[account];
        if (node.account == address(0)) revert NodeNotFound(account);
        if (account == root) revert CannotMutateRoot(account);

        address parent = node.parent;
        address[] storage kids = _children[account];
        uint256 kidCount = kids.length;
        for (uint256 i = 0; i < kidCount; i++) {
            address child = kids[i];
            _nodes[child].parent = parent;
            _children[parent].push(child);
        }
        delete _children[account];

        _removeFromParent(parent, account);
        delete _nodes[account];
        emit NodeRemoved(account, parent);
    }

    /// @notice Move `account` under `newParent`. Rejects cycles and root moves.
    function reparent(address account, address newParent) external {
        _authorize();
        Node storage node = _nodes[account];
        if (node.account == address(0)) revert NodeNotFound(account);
        if (account == root) revert CannotMutateRoot(account);
        if (_nodes[newParent].account == address(0)) revert InvalidParent(newParent);
        if (newParent == account) revert CyclicParent(account, newParent);
        if (_isAncestor(account, newParent)) revert CyclicParent(account, newParent);

        address oldParent = node.parent;
        if (oldParent == newParent) return;

        _removeFromParent(oldParent, account);
        node.parent = newParent;
        _children[newParent].push(account);
        emit NodeReparented(account, oldParent, newParent);
    }

    /// @dev True if `maybeAncestor` is on the path from `node` up to root.
    function _isAncestor(address maybeAncestor, address node) private view returns (bool) {
        address cursor = node;
        while (cursor != address(0)) {
            if (cursor == maybeAncestor) return true;
            cursor = _nodes[cursor].parent;
        }
        return false;
    }

    function _removeFromParent(address parent, address child) private {
        address[] storage siblings = _children[parent];
        uint256 n = siblings.length;
        for (uint256 i = 0; i < n; i++) {
            if (siblings[i] == child) {
                siblings[i] = siblings[n - 1];
                siblings.pop();
                return;
            }
        }
    }

    function _authorize() private view {
        if (governor != address(0)) {
            if (msg.sender != governor) revert NotAuthorized(msg.sender);
        } else if (msg.sender != root) {
            revert NotAuthorized(msg.sender);
        }
    }
}
