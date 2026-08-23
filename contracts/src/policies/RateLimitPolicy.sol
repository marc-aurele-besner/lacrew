// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";
import {IRateRecorder} from "../interfaces/IRateRecorder.sol";

/// @title RateLimitPolicy
/// @notice Escalates when an agent exceeds `maxActions` within `windowSeconds`.
/// @dev Who may count actions into a window is the whole security of the module:
///      an unrestricted `record` lets anyone push every agent into ESCALATE, and a
///      recorder bound by a stranger makes the router's own `record` revert, which
///      stops every ALLOW and every intent on the org. So the recorder is bound once,
///      by the deployer, and until it is bound only the deployer may record.
contract RateLimitPolicy is IPolicyModule, IRateRecorder {
    uint256 public immutable maxActions;
    uint256 public immutable windowSeconds;

    /// @notice Deployer; the only account that may bind the recorder.
    address public immutable admin;
    address public recorder;
    bool public recorderLocked;

    struct Window {
        uint64 windowStart;
        uint32 count;
    }

    mapping(address => Window) public windows;

    event RecorderBound(address indexed recorder);

    error NotRecorder(address caller);
    error NotAuthorized(address caller);
    error RecorderLocked();
    error ZeroAddress();

    constructor(uint256 maxActions_, uint256 windowSeconds_) {
        maxActions = maxActions_;
        windowSeconds = windowSeconds_;
        admin = msg.sender;
    }

    /// @notice Bind who may call `record` (typically EscalationRouter). Deployer-only, once.
    function setRecorder(address recorder_) external {
        if (msg.sender != admin) revert NotAuthorized(msg.sender);
        if (recorderLocked) revert RecorderLocked();
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
        recorderLocked = true;
        emit RecorderBound(recorder_);
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
    /// @dev Before the recorder is bound, only the deployer may record (unit tests
    ///      and local scaffolding); afterwards, only the bound recorder.
    function record(address agent) external {
        address allowed = recorder == address(0) ? admin : recorder;
        if (msg.sender != allowed) revert NotRecorder(msg.sender);

        Window storage w = windows[agent];
        if (w.windowStart == 0 || block.timestamp >= uint256(w.windowStart) + windowSeconds) {
            w.windowStart = uint64(block.timestamp);
            w.count = 1;
            return;
        }
        w.count += 1;
    }
}
