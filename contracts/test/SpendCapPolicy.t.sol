// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @dev Minimal forge-std-free assertions if forge-std is not installed yet.
/// TODO: `forge install foundry-rs/forge-std` and switch fully to forge-std Test helpers.
contract SpendCapPolicyTest is Test {
    SpendCapPolicy internal policy;

    function setUp() public {
        policy = new SpendCapPolicy(100 ether);
    }

    function test_allowsUnderCap() public view {
        Verdict v = policy.check(address(1), address(2), 50 ether, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));
    }

    function test_escalatesOverCap() public view {
        Verdict v = policy.check(address(1), address(2), 101 ether, "");
        assertEq(uint8(v), uint8(Verdict.ESCALATE));
    }
}
