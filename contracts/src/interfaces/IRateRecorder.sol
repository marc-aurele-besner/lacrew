// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IRateRecorder
/// @notice Optional hook EscalationRouter calls after a proposed/finalized action.
interface IRateRecorder {
    function record(address agent) external;
}
