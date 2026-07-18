// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";

contract GovernanceModuleTest is Test {
    address internal root = makeAddr("root");
    address internal voter1 = makeAddr("voter1");
    address internal voter2 = makeAddr("voter2");
    GovernanceModule internal gov;
    OrgRegistry internal registry;

    function setUp() public {
        registry = new OrgRegistry(root);
        gov = new GovernanceModule(root);
        vm.prank(root);
        registry.setGovernor(address(gov));

        vm.startPrank(root);
        gov.setVotingPower(voter1, 1);
        gov.setVotingPower(voter2, 1);
        gov.setQuorumYes(2);
        vm.stopPrank();
    }

    function test_proposeVoteAndExecuteAddsNode() public {
        address worker = makeAddr("worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );

        uint256 id = gov.propose(GovernanceModule.Tier.Low, address(registry), data);

        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);

        gov.execute(id);

        IOrgRegistry.Node memory node = registry.getNode(worker);
        assertEq(node.parent, root);
        assertEq(uint8(node.kind), uint8(IOrgRegistry.NodeKind.WorkerAgent));
    }

    function test_weightedVoteCanMeetQuorumAlone() public {
        address heavy = makeAddr("heavy");
        vm.prank(root);
        gov.setVotingPower(heavy, 2);

        address worker = makeAddr("solo-hire");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.Low, address(registry), data);

        vm.prank(heavy);
        gov.vote(id, true);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }

    function test_noSeatCannotVote() public {
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (makeAddr("w"), IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.Low, address(registry), data);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.NoVotingPower.selector, makeAddr("stranger"))
        );
        gov.vote(id, true);
    }

    function test_executeRequiresQuorum() public {
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (makeAddr("w"), IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(voter1);
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

        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);

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

        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);

        vm.warp(block.timestamp + 3 days + 1 days + 1);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }
}
