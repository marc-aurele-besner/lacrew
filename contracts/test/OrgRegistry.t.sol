// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";

contract OrgRegistryTest is Test {
    address internal root = makeAddr("root");
    OrgRegistry internal registry;

    function setUp() public {
        registry = new OrgRegistry(root);
    }

    function test_rootIsHuman() public view {
        IOrgRegistry.Node memory node = registry.getNode(root);
        assertEq(uint8(node.kind), uint8(IOrgRegistry.NodeKind.HumanRoot));
        assertEq(node.parent, address(0));
        assertTrue(node.active);
    }

    function test_addManagerAndWorker() public {
        address manager = makeAddr("manager");
        address worker = makeAddr("worker");

        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        address[] memory rootChildren = registry.getChildren(root);
        assertEq(rootChildren.length, 1);
        assertEq(rootChildren[0], manager);

        address[] memory mgrChildren = registry.getChildren(manager);
        assertEq(mgrChildren.length, 1);
        assertEq(mgrChildren[0], worker);

        IOrgRegistry.Node memory w = registry.getNode(worker);
        assertEq(w.parent, manager);
    }

    function test_rejectsStrangerAdd() public {
        address manager = makeAddr("manager");
        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.NotAuthorized.selector, address(this)));
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
    }

    function test_rejectsDuplicateNode() public {
        address manager = makeAddr("manager");
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.NodeAlreadyExists.selector, manager));
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
    }

    function test_rejectsUnknownParent() public {
        address manager = makeAddr("manager");
        address ghost = makeAddr("ghost");
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.InvalidParent.selector, ghost));
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, ghost);
    }

    function test_removeNodeRewiresChildrenToParent() public {
        address manager = makeAddr("manager");
        address worker = makeAddr("worker");
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        registry.removeNode(manager);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.NodeNotFound.selector, manager));
        registry.getNode(manager);

        IOrgRegistry.Node memory w = registry.getNode(worker);
        assertEq(w.parent, root);

        address[] memory rootChildren = registry.getChildren(root);
        assertEq(rootChildren.length, 1);
        assertEq(rootChildren[0], worker);
        assertEq(registry.getChildren(manager).length, 0);
    }

    function test_cannotRemoveRoot() public {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.CannotMutateRoot.selector, root));
        registry.removeNode(root);
    }

    function test_reparentMovesNode() public {
        address managerA = makeAddr("managerA");
        address managerB = makeAddr("managerB");
        address worker = makeAddr("worker");
        vm.startPrank(root);
        registry.addNode(managerA, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(managerB, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, managerA);
        registry.reparent(worker, managerB);
        vm.stopPrank();

        assertEq(registry.getNode(worker).parent, managerB);
        assertEq(registry.getChildren(managerA).length, 0);
        assertEq(registry.getChildren(managerB)[0], worker);
    }

    function test_reparentRejectsCycle() public {
        address manager = makeAddr("manager");
        address worker = makeAddr("worker");
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.expectRevert(abi.encodeWithSelector(OrgRegistry.CyclicParent.selector, manager, worker));
        registry.reparent(manager, worker);
        vm.stopPrank();
    }
}
