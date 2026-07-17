// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title ITreasurySpender
/// @notice Minimal surface EscalationRouter uses to debit an agent allowance.
interface ITreasurySpender {
    function spendAllowance(address node, uint256 amount, address to) external;
}
