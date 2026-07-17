// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Verdict returned by a policy module for a proposed action.
enum Verdict {
    ALLOW,
    ESCALATE,
    DENY
}

/// @title IPolicyModule
/// @notice Standard interface for LaCrew policy modules.
/// @dev Modules stack on a node; first DENY wins, any ESCALATE routes upward.
interface IPolicyModule {
    /// @notice Evaluate whether `agent` may call `target` with `value` and `data`.
    /// @param agent The agent account proposing the action.
    /// @param target The contract or account the agent wants to call.
    /// @param value Native value attached to the call.
    /// @param data Calldata for the call.
    /// @return verdict ALLOW, ESCALATE, or DENY.
    function check(
        address agent,
        address target,
        uint256 value,
        bytes calldata data
    ) external view returns (Verdict verdict);
}
