// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {Verdict} from "../src/interfaces/IPolicyModule.sol";

contract SpendCapPolicyTest is Test {
    SpendCapPolicy internal policy;
    address internal agent = makeAddr("agent");

    function setUp() public {
        policy = new SpendCapPolicy(100 ether);
    }

    function test_allowsUnderCap() public view {
        Verdict v = policy.check(agent, address(2), 50 ether, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));
    }

    function test_escalatesOverCap() public view {
        Verdict v = policy.check(agent, address(2), 101 ether, "");
        assertEq(uint8(v), uint8(Verdict.ESCALATE));
    }

    function test_perAgentOverride() public {
        policy.setAgentCap(agent, 200 ether);
        Verdict under = policy.check(agent, address(2), 150 ether, "");
        assertEq(uint8(under), uint8(Verdict.ALLOW));
        Verdict over = policy.check(agent, address(2), 201 ether, "");
        assertEq(uint8(over), uint8(Verdict.ESCALATE));
    }

    function test_strangerCannotSetAgentCap() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(SpendCapPolicy.NotAuthorized.selector, makeAddr("stranger"))
        );
        policy.setAgentCap(agent, 1 ether);
    }

    function test_governorCanSetAgentCap() public {
        address gov = makeAddr("gov");
        policy.setGovernor(gov);
        vm.prank(gov);
        policy.setAgentCap(agent, 250 ether);
        assertEq(policy.capOf(agent), 250 ether);
    }
}
