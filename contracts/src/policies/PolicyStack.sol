// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title PolicyStack
/// @notice Composes modules: first DENY wins; any ESCALATE is sticky; else ALLOW.
/// @dev Mocked: fixed module array set at construction.
contract PolicyStack is IPolicyModule {
    IPolicyModule[] public modules;

    error EmptyStack();

    constructor(IPolicyModule[] memory modules_) {
        if (modules_.length == 0) revert EmptyStack();
        for (uint256 i = 0; i < modules_.length; i++) {
            modules.push(modules_[i]);
        }
    }

    function moduleCount() external view returns (uint256) {
        return modules.length;
    }

    /// @inheritdoc IPolicyModule
    function check(
        address agent,
        address target,
        uint256 value,
        bytes calldata data
    ) external view returns (Verdict verdict) {
        bool escalate;
        for (uint256 i = 0; i < modules.length; i++) {
            Verdict v = modules[i].check(agent, target, value, data);
            if (v == Verdict.DENY) return Verdict.DENY;
            if (v == Verdict.ESCALATE) escalate = true;
        }
        return escalate ? Verdict.ESCALATE : Verdict.ALLOW;
    }
}
