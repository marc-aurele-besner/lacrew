// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title RateLimitPolicy
/// @notice Escalates when an agent exceeds `maxActions` within `windowSeconds`.
/// @dev Mocked: in-contract counters; not production-hardened against time manipulation.
contract RateLimitPolicy is IPolicyModule {
    uint256 public immutable maxActions;
    uint256 public immutable windowSeconds;

    struct Window {
        uint64 windowStart;
        uint32 count;
    }

    mapping(address => Window) public windows;

    /// TODO: Move velocity signals to off-chain guardian for soft alerts; keep hard caps here.
    constructor(uint256 maxActions_, uint256 windowSeconds_) {
        maxActions = maxActions_;
        windowSeconds = windowSeconds_;
    }

    /// @inheritdoc IPolicyModule
    /// @dev view-only check uses current stored count; callers that want mutation need a separate hook.
    /// Mocked: this module is view and does not increment — EscalationRouter would need a record() path.
    function check(
        address agent,
        address,
        uint256,
        bytes calldata
    ) external view returns (Verdict verdict) {
        Window memory w = windows[agent];
        if (w.windowStart == 0 || block.timestamp >= uint256(w.windowStart) + windowSeconds) {
            return Verdict.ALLOW;
        }
        if (w.count >= maxActions) return Verdict.ESCALATE;
        return Verdict.ALLOW;
    }

    /// @notice Record an attempted action for rate accounting.
    /// @dev Mocked: permissionless; TODO: restrict to EscalationRouter.
    function record(address agent) external {
        Window storage w = windows[agent];
        if (w.windowStart == 0 || block.timestamp >= uint256(w.windowStart) + windowSeconds) {
            w.windowStart = uint64(block.timestamp);
            w.count = 1;
            return;
        }
        w.count += 1;
    }
}
