// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

contract PerNodePolicyTest is Test {
    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");

    OrgRegistry internal registry;
    RateLimitPolicy internal rateLimit;
    EscalationRouter internal router;
    PolicyStack internal workerStack;
    PolicyStack internal managerStack;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);

        SpendCapPolicy spendCap = new SpendCapPolicy(100 ether);
        spendCap.setAgentCap(manager, 300 ether);
        spendCap.setAgentCap(root, type(uint256).max);

        rateLimit = new RateLimitPolicy(1, 1 hours);

        IPolicyModule[] memory wMods = new IPolicyModule[](3);
        wMods[0] = whitelist;
        wMods[1] = spendCap;
        wMods[2] = rateLimit;
        workerStack = new PolicyStack(wMods);

        IPolicyModule[] memory mMods = new IPolicyModule[](2);
        mMods[0] = whitelist;
        mMods[1] = spendCap;
        managerStack = new PolicyStack(mMods);

        router = new EscalationRouter(address(registry), address(workerStack));
        router.setRateRecorder(address(rateLimit));
        rateLimit.setRecorder(address(router));
        router.setNodePolicy(worker, address(workerStack));
        router.setNodePolicy(manager, address(managerStack));
    }

    function test_policyOfReturnsOverride() public view {
        assertEq(address(router.policyOf(worker)), address(workerStack));
        assertEq(address(router.policyOf(manager)), address(managerStack));
        assertEq(address(router.policyOf(root)), address(0));
    }

    function test_workerRateLimitEscalatesOnSecondPropose() public {
        (uint256 id0, Verdict v0) = router.propose(worker, goodTarget, 10 ether, "");
        assertEq(id0, 0);
        assertEq(uint8(v0), uint8(Verdict.ALLOW));

        // Worker stack has rate limit of 1 → second action ESCALATEs.
        (uint256 id1, Verdict v1) = router.propose(worker, goodTarget, 10 ether, "");
        assertEq(uint8(v1), uint8(Verdict.ESCALATE));
        assertEq(id1, 1);
    }

    function test_managerResolveUsesOwnStackWithoutRateLimit() public {
        // Force escalate via spend cap (over worker 100).
        (uint256 intentId,) = router.propose(worker, goodTarget, 150 ether, "");

        // Manager stack has no rate limit; under manager cap → ALLOW finalize.
        vm.prank(manager);
        router.resolve(intentId, true);

        (, , , , , bool resolved, bool approved) = router.intents(intentId);
        assertTrue(resolved);
        assertTrue(approved);
    }

    function test_clearNodePolicyFallsBackToDefault() public {
        router.setNodePolicy(worker, address(0));
        assertEq(address(router.policyOf(worker)), address(0));

        // Default policy is still workerStack (constructor arg) → under-cap ALLOW.
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 10 ether, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_setNodePolicyRequiresGovernorAfterBind() public {
        router.setGovernor(root);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, makeAddr("stranger"))
        );
        router.setNodePolicy(worker, address(managerStack));
    }
}
