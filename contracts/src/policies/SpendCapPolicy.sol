// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title SpendCapPolicy
/// @notice Allows spends at or under a per-agent cap; escalates overages.
/// @dev Mocked: default cap + optional per-agent overrides; no epoch reset yet.
contract SpendCapPolicy is IPolicyModule {
    uint256 public immutable defaultCap;
    mapping(address => uint256) public agentCap;
    mapping(address => bool) public hasAgentCap;

    event AgentCapSet(address indexed agent, uint256 cap);

    constructor(uint256 defaultCap_) {
        defaultCap = defaultCap_;
    }

    /// @notice Override the spend cap for a specific agent.
    /// @dev Mocked: permissionless setter for tests.
    /// TODO: Gate behind GovernanceModule / org root only.
    function setAgentCap(address agent, uint256 cap_) external {
        agentCap[agent] = cap_;
        hasAgentCap[agent] = true;
        emit AgentCapSet(agent, cap_);
    }

    function capOf(address agent) public view returns (uint256) {
        if (hasAgentCap[agent]) return agentCap[agent];
        return defaultCap;
    }

    /// @inheritdoc IPolicyModule
    function check(
        address agent,
        address,
        uint256 value,
        bytes calldata
    ) external view returns (Verdict verdict) {
        if (value <= capOf(agent)) return Verdict.ALLOW;
        return Verdict.ESCALATE;
    }
}
