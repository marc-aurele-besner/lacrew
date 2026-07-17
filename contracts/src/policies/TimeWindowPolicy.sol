// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title TimeWindowPolicy
/// @notice DENY actions outside a daily UTC window `[startSecond, endSecond)`.
/// @dev Window is measured as seconds since midnight UTC (`block.timestamp % 1 days`).
contract TimeWindowPolicy is IPolicyModule {
    /// @notice Inclusive start of the allowed window (seconds since midnight UTC).
    uint256 public immutable startSecondOfDay;
    /// @notice Exclusive end of the allowed window (seconds since midnight UTC).
    uint256 public immutable endSecondOfDay;

    error InvalidWindow(uint256 startSecond, uint256 endSecond);

    /// @param startSecondOfDay_ e.g. 9 hours = 32400
    /// @param endSecondOfDay_ e.g. 17 hours = 61200; must be > start
    constructor(uint256 startSecondOfDay_, uint256 endSecondOfDay_) {
        if (endSecondOfDay_ <= startSecondOfDay_ || endSecondOfDay_ > 1 days) {
            revert InvalidWindow(startSecondOfDay_, endSecondOfDay_);
        }
        startSecondOfDay = startSecondOfDay_;
        endSecondOfDay = endSecondOfDay_;
    }

    /// @inheritdoc IPolicyModule
    function check(
        address,
        address,
        uint256,
        bytes calldata
    ) external view returns (Verdict verdict) {
        uint256 tod = block.timestamp % 1 days;
        if (tod < startSecondOfDay || tod >= endSecondOfDay) {
            return Verdict.DENY;
        }
        return Verdict.ALLOW;
    }
}
