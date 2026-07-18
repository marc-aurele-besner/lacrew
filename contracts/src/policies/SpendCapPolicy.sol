// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "../interfaces/IPolicyModule.sol";

/// @title SpendCapPolicy
/// @notice Allows spends at or under a per-agent cap; escalates overages.
/// @dev Mutators gated by admin (deployer) or governor (GovernanceModule).
contract SpendCapPolicy is IPolicyModule {
    uint256 public immutable defaultCap;
    mapping(address => uint256) public agentCap;
    mapping(address => bool) public hasAgentCap;
    address public admin;
    address public governor;

    event AgentCapSet(address indexed agent, uint256 cap);
    event GovernorUpdated(address indexed governor);

    error NotAuthorized(address caller);
    error ZeroAddress();
    error GovernorAlreadySet();

    constructor(uint256 defaultCap_) {
        defaultCap = defaultCap_;
        admin = msg.sender;
    }

    /// @notice Bind constitutional authority. Callable once by admin.
    function setGovernor(address governor_) external {
        if (msg.sender != admin) revert NotAuthorized(msg.sender);
        if (governor_ == address(0)) revert ZeroAddress();
        if (governor != address(0)) revert GovernorAlreadySet();
        governor = governor_;
        emit GovernorUpdated(governor_);
    }

    /// @notice Override the spend cap for a specific agent.
    function setAgentCap(address agent, uint256 cap_) external {
        if (msg.sender != admin && msg.sender != governor) revert NotAuthorized(msg.sender);
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
