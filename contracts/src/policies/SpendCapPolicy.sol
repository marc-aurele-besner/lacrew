// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title SpendCapPolicy
/// @notice Allows spends at or under a per-agent cap; escalates overages.
/// @dev Mocked: single global cap for all agents; ignores target whitelist.
contract SpendCapPolicy is IPolicyModule {
    uint256 public immutable cap;

    /// TODO: Per-agent caps + epoch reset + whitelist of targets.
    constructor(uint256 cap_) {
        cap = cap_;
    }

    /// @inheritdoc IPolicyModule
    function check(
        address,
        address,
        uint256 value,
        bytes calldata
    ) external view returns (Verdict verdict) {
        if (value <= cap) return Verdict.ALLOW;
        return Verdict.ESCALATE;
    }
}
