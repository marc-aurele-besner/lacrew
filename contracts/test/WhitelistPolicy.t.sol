// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {Verdict} from "../src/interfaces/IPolicyModule.sol";

contract WhitelistPolicyTest is Test {
    WhitelistPolicy internal policy;
    address internal target = makeAddr("target");

    function setUp() public {
        policy = new WhitelistPolicy();
    }

    function test_deniesUnknown() public view {
        Verdict v = policy.check(address(1), target, 1, "");
        assertEq(uint8(v), uint8(Verdict.DENY));
    }

    function test_allowsWhitelisted() public {
        policy.setAllowed(target, true);
        Verdict v = policy.check(address(1), target, 1, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));
    }

    function test_strangerCannotSetAllowed() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(WhitelistPolicy.NotAuthorized.selector, makeAddr("stranger"))
        );
        policy.setAllowed(target, true);
    }

    function test_governorCanSetAllowed() public {
        address gov = makeAddr("gov");
        policy.setGovernor(gov);
        vm.prank(gov);
        policy.setAllowed(target, true);
        assertTrue(policy.allowed(target));
    }
}
