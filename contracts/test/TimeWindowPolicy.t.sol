// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimeWindowPolicy} from "../src/policies/TimeWindowPolicy.sol";
import {Verdict} from "../src/interfaces/IPolicyModule.sol";

contract TimeWindowPolicyTest is Test {
    TimeWindowPolicy internal policy;
    address internal agent = makeAddr("agent");

    function setUp() public {
        // 09:00–17:00 UTC
        policy = new TimeWindowPolicy(9 hours, 17 hours);
        // Freeze at a known Monday 00:00 UTC-ish epoch
        vm.warp(1_704_067_200); // 2024-01-01 00:00:00 UTC
    }

    function test_allowsInsideWindow() public {
        vm.warp(block.timestamp + 10 hours);
        assertEq(uint8(policy.check(agent, address(0), 0, "")), uint8(Verdict.ALLOW));
    }

    function test_deniesOutsideWindow() public {
        vm.warp(block.timestamp + 8 hours);
        assertEq(uint8(policy.check(agent, address(0), 0, "")), uint8(Verdict.DENY));

        vm.warp(block.timestamp + 10 hours); // 18:00
        assertEq(uint8(policy.check(agent, address(0), 0, "")), uint8(Verdict.DENY));
    }

    function test_rejectsInvalidWindow() public {
        vm.expectRevert(
            abi.encodeWithSelector(TimeWindowPolicy.InvalidWindow.selector, 17 hours, 9 hours)
        );
        new TimeWindowPolicy(17 hours, 9 hours);
    }
}
