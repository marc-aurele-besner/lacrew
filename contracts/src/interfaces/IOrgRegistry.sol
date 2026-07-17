// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IOrgRegistry
/// @notice Org tree: human roots, manager agents, worker agents, and reporting edges.
/// @dev Structural changes must flow through GovernanceModule (not implemented yet).
interface IOrgRegistry {
    enum NodeKind {
        HumanRoot,
        ManagerAgent,
        WorkerAgent
    }

    struct Node {
        address account;
        NodeKind kind;
        address parent;
        bool active;
    }

    /// @notice Returns node metadata for `account`.
    function getNode(address account) external view returns (Node memory node);

    /// @notice Returns direct reports of `parent`.
    function getChildren(address parent) external view returns (address[] memory children);
}
