// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title WhitelistPolicy
/// @notice ALLOWs calls to whitelisted targets; DENYs everything else.
/// @dev Mocked: ownerless setter for local tests; no governance gating.
contract WhitelistPolicy is IPolicyModule {
    mapping(address => bool) public allowed;

    event TargetAllowed(address indexed target, bool allowed);

    /// TODO: Gate setAllowed behind GovernanceModule / org root only.
    function setAllowed(address target, bool isAllowed) external {
        allowed[target] = isAllowed;
        emit TargetAllowed(target, isAllowed);
    }

    /// @inheritdoc IPolicyModule
    function check(
        address,
        address target,
        uint256,
        bytes calldata
    ) external view returns (Verdict verdict) {
        if (allowed[target]) return Verdict.ALLOW;
        return Verdict.DENY;
    }
}
