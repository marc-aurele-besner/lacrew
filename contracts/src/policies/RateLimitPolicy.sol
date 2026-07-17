// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";
import {IRateRecorder} from "../interfaces/IRateRecorder.sol";

/// @title RateLimitPolicy
/// @notice Escalates when an agent exceeds `maxActions` within `windowSeconds`.
contract RateLimitPolicy is IPolicyModule, IRateRecorder {
    uint256 public immutable maxActions;
    uint256 public immutable windowSeconds;

    address public recorder;
    bool public recorderLocked;

    struct Window {
        uint64 windowStart;
        uint32 count;
    }

    mapping(address => Window) public windows;

    error NotRecorder(address caller);

    constructor(uint256 maxActions_, uint256 windowSeconds_) {
        maxActions = maxActions_;
        windowSeconds = windowSeconds_;
    }

    /// @notice Bind who may call `record` (typically EscalationRouter). Lock after set.
    function setRecorder(address recorder_) external {
        if (recorderLocked) revert NotRecorder(msg.sender);
        recorder = recorder_;
        recorderLocked = true;
    }

    /// @inheritdoc IPolicyModule
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

    /// @inheritdoc IRateRecorder
    function record(address agent) external {
        if (recorder != address(0) && msg.sender != recorder) revert NotRecorder(msg.sender);

        Window storage w = windows[agent];
        if (w.windowStart == 0 || block.timestamp >= uint256(w.windowStart) + windowSeconds) {
            w.windowStart = uint64(block.timestamp);
            w.count = 1;
            return;
        }
        w.count += 1;
    }
}
