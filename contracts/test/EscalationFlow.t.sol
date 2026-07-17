// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

contract EscalationFlowTest is Test {
    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");
    address internal badTarget = makeAddr("badTarget");

    OrgRegistry internal registry;
    WhitelistPolicy internal whitelist;
    SpendCapPolicy internal spendCap;
    PolicyStack internal stack;
    EscalationRouter internal router;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);

        spendCap = new SpendCapPolicy(100 ether);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
    }

    function test_allowsUnderCapOnWhitelist() public {
        (uint256 intentId, Verdict verdict) =
            router.propose(worker, goodTarget, 50 ether, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_escalatesOverCapToManager() public {
        (uint256 intentId, Verdict verdict) =
            router.propose(worker, goodTarget, 150 ether, "");
        assertEq(uint8(verdict), uint8(Verdict.ESCALATE));
        assertEq(intentId, 1);

        (address agent,,,,,,) = _intent(intentId);
        assertEq(agent, worker);

        (, , , , address awaiting, bool resolved,) = _intent(intentId);
        assertEq(awaiting, manager);
        assertFalse(resolved);
    }

    function test_managerCanApproveEscalation() public {
        (uint256 intentId,) = router.propose(worker, goodTarget, 150 ether, "");

        vm.prank(manager);
        router.resolve(intentId, true);

        (, , , , , bool resolved, bool approved) = _intent(intentId);
        assertTrue(resolved);
        assertTrue(approved);
    }

    function test_deniesNonWhitelistedTarget() public {
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.UnexpectedVerdict.selector, Verdict.DENY)
        );
        router.propose(worker, badTarget, 1 ether, "");
    }

    function test_strangerCannotResolve() public {
        (uint256 intentId,) = router.propose(worker, goodTarget, 150 ether, "");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.NotAwaitingApprover.selector, makeAddr("stranger"))
        );
        router.resolve(intentId, true);
    }

    function _intent(uint256 id)
        internal
        view
        returns (
            address agent,
            address target,
            uint256 value,
            bytes memory data,
            address awaitingApprover,
            bool resolved,
            bool approved
        )
    {
        return router.intents(id);
    }
}
