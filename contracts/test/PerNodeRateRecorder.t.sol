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

/// A node bound to its own RateLimitPolicy needs its executed actions counted
/// in that module's windows — the global recorder never sees them, so without
/// the per-node recorder a custom rate limit would silently never trip.
contract PerNodeRateRecorderTest is Test {
    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");

    OrgRegistry internal registry;
    RateLimitPolicy internal globalRate;
    RateLimitPolicy internal customRate;
    EscalationRouter internal router;
    PolicyStack internal defaultStack;
    PolicyStack internal customStack;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(100 ether);

        globalRate = new RateLimitPolicy(10, 1 hours);
        customRate = new RateLimitPolicy(1, 1 hours);

        IPolicyModule[] memory defMods = new IPolicyModule[](3);
        defMods[0] = whitelist;
        defMods[1] = spendCap;
        defMods[2] = globalRate;
        defaultStack = new PolicyStack(defMods);

        IPolicyModule[] memory customMods = new IPolicyModule[](3);
        customMods[0] = whitelist;
        customMods[1] = spendCap;
        customMods[2] = customRate;
        customStack = new PolicyStack(customMods);

        router = new EscalationRouter(address(registry), address(defaultStack));
        router.setRateRecorder(address(globalRate));
        globalRate.setRecorder(address(router));
        customRate.setRecorder(address(router));

        router.setNodePolicy(worker, address(customStack));
        router.setNodeRateRecorder(worker, address(customRate));
    }

    function test_customRecorderCountsTheBoundNode() public {
        (, Verdict v0) = router.propose(worker, goodTarget, 1 ether, "");
        assertEq(uint8(v0), uint8(Verdict.ALLOW));

        // The executed action landed in the custom module, not the global one.
        (uint64 customStart, uint32 customCount) = customRate.windows(worker);
        (, uint32 globalCount) = globalRate.windows(worker);
        assertGt(customStart, 0);
        assertEq(customCount, 1);
        assertEq(globalCount, 0);

        // customRate caps at 1/hour → the very next action escalates, which the
        // old single global recorder could never make happen.
        (, Verdict v1) = router.propose(worker, goodTarget, 1 ether, "");
        assertEq(uint8(v1), uint8(Verdict.ESCALATE));
    }

    function test_unboundNodesStillRecordGlobally() public {
        (, Verdict v) = router.propose(manager, goodTarget, 1 ether, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));

        (, uint32 globalCount) = globalRate.windows(manager);
        (, uint32 customCount) = customRate.windows(manager);
        assertEq(globalCount, 1);
        assertEq(customCount, 0);
    }

    function test_clearingFallsBackToGlobal() public {
        router.setNodeRateRecorder(worker, address(0));
        (, Verdict v) = router.propose(worker, goodTarget, 1 ether, "");
        assertEq(uint8(v), uint8(Verdict.ALLOW));

        (, uint32 globalCount) = globalRate.windows(worker);
        (, uint32 customCount) = customRate.windows(worker);
        assertEq(globalCount, 1);
        assertEq(customCount, 0);
    }

    function test_setNodeRateRecorderGovernorGatedAfterBind() public {
        router.setGovernor(root);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger)
        );
        router.setNodeRateRecorder(worker, address(globalRate));

        // The governor itself still may.
        vm.prank(root);
        router.setNodeRateRecorder(worker, address(globalRate));
        assertEq(address(router.rateRecorderOf(worker)), address(globalRate));
    }

    function test_zeroNodeReverts() public {
        vm.expectRevert(EscalationRouter.ZeroAddress.selector);
        router.setNodeRateRecorder(address(0), address(customRate));
    }
}
