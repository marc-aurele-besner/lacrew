// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";

contract GovernanceModuleTest is Test {
    address internal root = makeAddr("root");
    GovernanceModule internal gov;
    OrgRegistry internal registry;

    function setUp() public {
        registry = new OrgRegistry(root);
        gov = new GovernanceModule(root);
        vm.prank(root);
        registry.setGovernor(address(gov));
    }

    function test_proposeVoteAndExecuteAddsNode() public {
        address worker = makeAddr("worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );

        uint256 id = gov.propose(GovernanceModule.Tier.Low, address(registry), data);

        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);
        vm.prank(makeAddr("voter2"));
        gov.vote(id, true);

        gov.execute(id);

        IOrgRegistry.Node memory node = registry.getNode(worker);
        assertEq(node.parent, root);
        assertEq(uint8(node.kind), uint8(IOrgRegistry.NodeKind.WorkerAgent));
    }

    function test_executeRequiresQuorum() public {
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (makeAddr("w"), IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);

        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.QuorumNotMet.selector, id));
        gov.execute(id);
    }

    function test_highTierTimelockAndVeto() public {
        address worker = makeAddr("timed-worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);
        vm.prank(makeAddr("voter2"));
        gov.vote(id, true);

        // Before eta (deadline + 1 day) execute reverts.
        vm.expectRevert();
        gov.execute(id);

        vm.prank(root);
        gov.veto(id);

        (, , , , , , , , , GovernanceModule.ProposalState state) = gov.proposals(id);
        assertEq(uint8(state), uint8(GovernanceModule.ProposalState.Vetoed));
    }

    function test_highTierExecutesAfterTimelock() public {
        address worker = makeAddr("late-worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);
        vm.prank(makeAddr("voter2"));
        gov.vote(id, true);

        vm.warp(block.timestamp + 3 days + 1 days + 1);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }
}
