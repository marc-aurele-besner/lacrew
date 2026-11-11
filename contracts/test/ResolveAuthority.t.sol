// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";

/// Who may resolve a pending intent once the tree has changed underneath it:
/// only active nodes approve, an intent whose agent has left cannot be approved,
/// and the org root stands in for an approver that is inactive or gone.
contract ResolveAuthorityTest is Test {
    address internal root = makeAddr("root");
    address internal director = makeAddr("director");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE = 1e6;

    OrgRegistry internal registry;
    SpendCapPolicy internal spendCap;
    EscalationRouter internal router;
    Treasury internal treasury;
    MockUSDC internal usdc;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(director, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, director);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        // Worker 100, manager 300, director 1000; the root finalizes regardless.
        spendCap = new SpendCapPolicy(100 * ONE);
        spendCap.setAgentCap(manager, 300 * ONE);
        spendCap.setAgentCap(director, 1000 * ONE);

        router = new EscalationRouter(address(registry), address(spendCap));
        usdc = new MockUSDC();
        treasury = new Treasury(address(registry), address(usdc), address(router));
        router.setTreasury(address(treasury));

        usdc.mint(address(this), 10_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.deposit(10_000 * ONE);
        treasury.streamAllowance(worker, 5_000 * ONE, 1);
    }

    function _escalate(uint256 value) internal returns (uint256 intentId) {
        (intentId,) = router.propose(worker, payee, value, "");
    }

    function _state(uint256 intentId) internal view returns (address awaiting, bool resolved, bool approved) {
        (, , , , awaiting, resolved, approved) = router.intents(intentId);
    }

    function test_deactivatedApproverCannotApprove() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(manager, false);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveApprover.selector, manager));
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_deactivatedApproverCannotReject() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(manager, false);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveApprover.selector, manager));
        router.resolve(id, false);
    }

    function test_removedApproverCannotApprove() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.removeNode(manager);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveApprover.selector, manager));
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_reactivatedApproverApprovesAgain() public {
        uint256 id = _escalate(150 * ONE);
        vm.startPrank(root);
        registry.setActive(manager, false);
        registry.setActive(manager, true);
        vm.stopPrank();

        vm.prank(manager);
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 150 * ONE);
    }

    function test_intentOfDeactivatedAgentCannotBeApproved() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(worker, false);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveAgent.selector, worker));
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 0);
        assertEq(treasury.allowanceBalance(worker), 5_000 * ONE);
    }

    function test_intentOfRemovedAgentCannotBeApproved() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.removeNode(worker);

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveAgent.selector, worker));
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_intentOfDeactivatedAgentCanStillBeRejected() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(worker, false);

        vm.prank(manager);
        router.resolve(id, false);
        (, bool resolved, bool approved) = _state(id);
        assertTrue(resolved);
        assertFalse(approved);
    }

    /// The agent leaves after the first approver has already passed the intent up:
    /// the next approver cannot finalize it either.
    function test_agentDeactivatedMidClimbCannotBeFinalized() public {
        uint256 id = _escalate(400 * ONE);
        vm.prank(manager);
        router.resolve(id, true);
        (address awaiting,,) = _state(id);
        assertEq(awaiting, director);

        vm.prank(root);
        registry.setActive(worker, false);

        vm.prank(director);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveAgent.selector, worker));
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_rootApprovesInPlaceOfDeactivatedApprover() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(manager, false);

        vm.prank(root);
        router.resolve(id, true);
        (, bool resolved, bool approved) = _state(id);
        assertTrue(resolved);
        assertTrue(approved);
        assertEq(usdc.balanceOf(payee), 150 * ONE);
    }

    /// Over the removed approver's own cap: the path that used to end in NodeNotFound.
    function test_rootApprovesInPlaceOfRemovedApprover() public {
        uint256 id = _escalate(400 * ONE);
        vm.prank(root);
        registry.removeNode(manager);

        vm.prank(root);
        router.resolve(id, true);
        (, bool resolved, bool approved) = _state(id);
        assertTrue(resolved);
        assertTrue(approved);
        assertEq(usdc.balanceOf(payee), 400 * ONE);
    }

    function test_rootRejectsInPlaceOfRemovedApprover() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.removeNode(manager);

        vm.prank(root);
        router.resolve(id, false);
        (, bool resolved, bool approved) = _state(id);
        assertTrue(resolved);
        assertFalse(approved);
    }

    /// The climb can land on an approver that is already inactive; the root covers it.
    function test_rootCoversAnInactiveApproverReachedByClimbing() public {
        uint256 id = _escalate(400 * ONE);
        vm.prank(root);
        registry.setActive(director, false);

        vm.prank(manager);
        router.resolve(id, true);
        (address awaiting, bool resolved,) = _state(id);
        assertEq(awaiting, director);
        assertFalse(resolved);

        vm.prank(root);
        router.resolve(id, true);
        assertEq(usdc.balanceOf(payee), 400 * ONE);
    }

    function test_rootCannotPreemptAnActiveApprover() public {
        uint256 id = _escalate(150 * ONE);

        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAwaitingApprover.selector, root));
        router.resolve(id, true);
    }

    function test_onlyRootStandsInForAnInactiveApprover() public {
        uint256 id = _escalate(150 * ONE);
        vm.prank(root);
        registry.setActive(manager, false);

        vm.prank(director);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAwaitingApprover.selector, director));
        router.resolve(id, true);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAwaitingApprover.selector, stranger));
        router.resolve(id, false);
    }

    /// Standing in does not lend the root's authority to a departed agent.
    function test_rootCannotApproveForDeactivatedAgentEither() public {
        uint256 id = _escalate(150 * ONE);
        vm.startPrank(root);
        registry.setActive(manager, false);
        registry.setActive(worker, false);

        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.InactiveAgent.selector, worker));
        router.resolve(id, true);

        router.resolve(id, false);
        vm.stopPrank();
        (, bool resolved, bool approved) = _state(id);
        assertTrue(resolved);
        assertFalse(approved);
    }
}
