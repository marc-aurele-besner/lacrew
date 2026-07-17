// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {Verdict} from "../src/interfaces/IPolicyModule.sol";

contract RateLimitPolicyTest is Test {
    RateLimitPolicy internal policy;
    address internal agent = makeAddr("agent");

    function setUp() public {
        policy = new RateLimitPolicy(2, 1 hours);
    }

    function test_allowsWithinLimit() public {
        policy.record(agent);
        Verdict v = policy.check(agent, address(1), 0, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));
    }

    function test_escalatesWhenOverLimit() public {
        policy.record(agent);
        policy.record(agent);
        Verdict v = policy.check(agent, address(1), 0, "");
        assertEq(uint8(v), uint8(Verdict.ESCALATE));
    }

    function test_resetsAfterWindow() public {
        policy.record(agent);
        policy.record(agent);
        vm.warp(block.timestamp + 1 hours + 1);
        Verdict v = policy.check(agent, address(1), 0, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));
    }
}
