// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Treasury
/// @notice Holds org funds and streams allowances downward on epoch schedules.
/// @dev Mocked: tracks balances in a mapping; no real ERC-20 streaming yet.
contract Treasury {
    address public immutable orgRegistry;

    /// @dev Mocked: token address ignored; balances are synthetic units.
    mapping(address => uint256) public allowanceBalance;

    event AllowanceStreamed(address indexed node, uint256 amount, uint64 epoch);
    event AllowanceSpent(address indexed node, uint256 amount);

    error InsufficientAllowance(address node, uint256 requested, uint256 available);

    /// TODO: Accept a real OrgRegistry + ERC-20 token (USDC) and epoch config.
    constructor(address orgRegistry_) {
        orgRegistry = orgRegistry_;
    }

    /// @notice Credit `node` with `amount` for the current epoch.
    /// @dev Mocked: anyone can stream; no epoch clock or policy attachment.
    /// TODO: Restrict to epoch job / authorized streamer; pull from real token balance.
    function streamAllowance(address node, uint256 amount, uint64 epoch) external {
        allowanceBalance[node] += amount;
        emit AllowanceStreamed(node, amount, epoch);
    }

    /// @notice Debit `node` allowance when an ALLOW action settles.
    /// @dev Mocked: no PolicyModule check here yet.
    /// TODO: Only EscalationRouter / account module may spend after policy ALLOW.
    function spendAllowance(address node, uint256 amount) external {
        uint256 available = allowanceBalance[node];
        if (available < amount) revert InsufficientAllowance(node, amount, available);
        allowanceBalance[node] = available - amount;
        emit AllowanceSpent(node, amount);
    }
}
