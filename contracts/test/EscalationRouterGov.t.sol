// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {IPolicyModule} from "../src/interfaces/IPolicyModule.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";

contract EscalationRouterGovTest is Test {
    address internal root = makeAddr("root");
    EscalationRouter internal router;

    function setUp() public {
        OrgRegistry registry = new OrgRegistry(root);
        SpendCapPolicy cap = new SpendCapPolicy(1e6);
        IPolicyModule[] memory modules = new IPolicyModule[](1);
        modules[0] = cap;
        PolicyStack stack = new PolicyStack(modules);
        router = new EscalationRouter(address(registry), address(stack));
    }

    function test_bootstrapSetTreasuryThenGovernorGates() public {
        address treasury = makeAddr("treasury");
        router.setTreasury(treasury);
        assertEq(address(router.treasury()), treasury);

        address gov = makeAddr("gov");
        router.setGovernor(gov);
        assertEq(router.governor(), gov);

        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, address(this)));
        router.setTreasury(makeAddr("other"));

        vm.prank(gov);
        router.setTreasury(makeAddr("wired"));
        assertEq(address(router.treasury()), makeAddr("wired"));
    }
}
