// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title SessionScopes
/// @notice Bit positions for session key scopes, shared by SessionRegistry (which
///         stores and validates a mask) and EscalationRouter (which gates on it).
/// @dev A library of constants rather than reads off the registry: these are
///      compile-time values, and fetching them over an external call would spend
///      gas on every propose to learn something already known at build time.
///      Mirrored in TypeScript by `SESSION_SCOPE_BIT` in the core package.
library SessionScopes {
    /// @notice May call `EscalationRouter.propose` at all.
    uint256 internal constant PROPOSE_INTENT = 1 << 0;
    /// @notice May let an ALLOW verdict settle funds immediately. Without it a
    ///         session can raise intents but never move money on its own.
    uint256 internal constant SPEND_WHITELIST = 1 << 1;
    /// @notice Every bit this version knows about.
    uint256 internal constant ALL = PROPOSE_INTENT | SPEND_WHITELIST;
}
