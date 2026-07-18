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
    address internal agent = makeAddr("agent-seat");
    GovernanceModule internal gov;
    OrgRegistry internal registry;

    function setUp() public {
        registry = new OrgRegistry(root);
        gov = new GovernanceModule(root);
        vm.prank(root);
        registry.setGovernor(address(gov));

        vm.startPrank(root);
        gov.setVotingPower(voter1, 1, GovernanceModule.SeatRole.Human);
        gov.setVotingPower(voter2, 1, GovernanceModule.SeatRole.Human);
        gov.setVotingPower(agent, 1, GovernanceModule.SeatRole.Agent);
        gov.setQuorumYes(2);
        gov.setQuorumHumanYes(1);
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
        gov.setVotingPower(heavy, 2, GovernanceModule.SeatRole.Human);

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
        // Agent review vote alone cannot satisfy high-tier human quorum.
        vm.prank(agent);
        gov.vote(id, true);

        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.QuorumNotMet.selector, id));
        gov.execute(id);
    }

    function test_agentYesCountsForLowTier() public {
        address worker = makeAddr("agent-low");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.Low, address(registry), data);

        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(agent);
        gov.vote(id, true);

        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }

    function test_highTierRequiresHumanQuorumDespiteAgentYes() public {
        address worker = makeAddr("needs-human");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(agent);
        gov.vote(id, true);
        // Two agent-style votes still insufficient without human yes — bump agent power.
        address agent2 = makeAddr("agent2");
        vm.prank(root);
        gov.setVotingPower(agent2, 5, GovernanceModule.SeatRole.Agent);
        vm.prank(agent2);
        gov.vote(id, true);

        vm.warp(block.timestamp + 3 days + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.QuorumNotMet.selector, id));
        gov.execute(id);

        // Human seat clears high-tier final say (fresh proposal needs its own timelock).
        uint256 id2 = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(voter1);
        gov.vote(id2, true);
        (, , , , , , , , , uint256 eta2, ) = gov.proposals(id2);
        vm.warp(eta2 + 1);
        gov.execute(id2);
        assertEq(registry.getNode(worker).account, worker);
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

        vm.expectRevert();
        gov.execute(id);

        vm.prank(root);
        gov.veto(id);

        (, , , , , , , , , , GovernanceModule.ProposalState state) = gov.proposals(id);
        assertEq(uint8(state), uint8(GovernanceModule.ProposalState.Vetoed));
    }

    function test_humanSeatCanVeto() public {
        address worker = makeAddr("seat-vetoed");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        // voter2 is a funded Human seat but not the root.
        vm.prank(voter2);
        gov.veto(id);

        (, , , , , , , , , , GovernanceModule.ProposalState state) = gov.proposals(id);
        assertEq(uint8(state), uint8(GovernanceModule.ProposalState.Vetoed));
    }

    function test_agentSeatCannotVeto() public {
        address worker = makeAddr("agent-veto-try");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.NotHumanSeat.selector, agent)
        );
        gov.veto(id);
    }

    function test_strangerCannotVeto() public {
        address worker = makeAddr("stranger-veto-try");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        address stranger = makeAddr("veto-stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.NotHumanSeat.selector, stranger)
        );
        gov.veto(id);
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

        vm.warp(block.timestamp + 3 days + 1 days + 1);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }

    function test_executeRemoveNodeRewiresViaGovernance() public {
        address manager = makeAddr("mgr-fire");
        address worker = makeAddr("w-rewire");
        bytes memory hireMgr = abi.encodeCall(
            OrgRegistry.addNode, (manager, IOrgRegistry.NodeKind.ManagerAgent, root)
        );
        bytes memory hireWorker = abi.encodeCall(
            OrgRegistry.addNode, (worker, IOrgRegistry.NodeKind.WorkerAgent, manager)
        );
        uint256 id1 = gov.propose(GovernanceModule.Tier.Low, address(registry), hireMgr);
        vm.prank(voter1);
        gov.vote(id1, true);
        vm.prank(voter2);
        gov.vote(id1, true);
        gov.execute(id1);

        uint256 id2 = gov.propose(GovernanceModule.Tier.Low, address(registry), hireWorker);
        vm.prank(voter1);
        gov.vote(id2, true);
        vm.prank(voter2);
        gov.vote(id2, true);
        gov.execute(id2);

        bytes memory fire = abi.encodeCall(OrgRegistry.removeNode, (manager));
        uint256 id3 = gov.propose(GovernanceModule.Tier.Low, address(registry), fire);
        vm.prank(voter1);
        gov.vote(id3, true);
        vm.prank(voter2);
        gov.vote(id3, true);
        gov.execute(id3);

        assertEq(registry.getNode(worker).parent, root);
    }
}
