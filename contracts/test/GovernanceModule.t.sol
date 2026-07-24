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
        gov = new GovernanceModule(root, 2);
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

    /// Fresh org, one human, default quorums: no deadlock, no waiting.
    function test_soloRootBootstrapExecutesLowTierImmediately() public {
        address solo = makeAddr("solo-root");
        OrgRegistry soloRegistry = new OrgRegistry(solo);
        GovernanceModule soloGov = new GovernanceModule(solo, 2);
        vm.prank(solo);
        soloRegistry.setGovernor(address(soloGov));

        address worker = makeAddr("first-hire");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, solo)
        );
        uint256 id = soloGov.propose(GovernanceModule.Tier.Low, address(soloRegistry), data);

        vm.prank(solo);
        soloGov.vote(id, true);
        soloGov.execute(id);
        assertEq(soloRegistry.getNode(worker).account, worker);
    }

    /// Unanimity fast path: a solo root's high-tier proposal skips the timelock.
    function test_soloRootHighTierSkipsTimelockOnUnanimity() public {
        address solo = makeAddr("solo-root-high");
        OrgRegistry soloRegistry = new OrgRegistry(solo);
        GovernanceModule soloGov = new GovernanceModule(solo, 2);
        vm.prank(solo);
        soloRegistry.setGovernor(address(soloGov));

        address managerHire = makeAddr("first-manager");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (managerHire, IOrgRegistry.NodeKind.ManagerAgent, solo)
        );
        uint256 id = soloGov.propose(GovernanceModule.Tier.High, address(soloRegistry), data);

        vm.prank(solo);
        soloGov.vote(id, true);
        soloGov.execute(id);
        assertEq(soloRegistry.getNode(managerHire).account, managerHire);
    }

    /// Effective quorum clamps to seated weight: even a weight-1 root is not
    /// deadlocked behind quorumYes = 2 when no other seats exist.
    function test_effectiveQuorumClampsToSeatedWeight() public {
        address solo = makeAddr("light-root");
        OrgRegistry soloRegistry = new OrgRegistry(solo);
        GovernanceModule soloGov = new GovernanceModule(solo, 1);
        vm.prank(solo);
        soloRegistry.setGovernor(address(soloGov));
        assertEq(soloGov.effectiveQuorumYes(), 1);

        address worker = makeAddr("clamped-hire");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, solo)
        );
        uint256 id = soloGov.propose(GovernanceModule.Tier.Low, address(soloRegistry), data);
        vm.prank(solo);
        soloGov.vote(id, true);
        soloGov.execute(id);
        assertEq(soloRegistry.getNode(worker).account, worker);

        // Seating more weight restores the configured quorum.
        vm.prank(solo);
        soloGov.setVotingPower(makeAddr("second-seat"), 3, GovernanceModule.SeatRole.Agent);
        assertEq(soloGov.effectiveQuorumYes(), 2);
    }

    /// The fast path needs ALL human weight — one silent human keeps the timelock.
    function test_fastPathBlockedWhileAnotherHumanHasNotVoted() public {
        address worker = makeAddr("guarded-worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(root);
        gov.vote(id, true);
        vm.prank(voter1);
        gov.vote(id, true);
        // voter2 (human, weight 1) has not voted: 3 of 4 human weight is not unanimity.
        (, , , , , , , , , uint256 eta, ) = gov.proposals(id);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.TimelockNotElapsed.selector, id, eta)
        );
        gov.execute(id);

        vm.prank(voter2);
        gov.vote(id, true);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }

    function test_fastPathCanBeDisabled() public {
        vm.prank(root);
        gov.setUnanimityFastPath(false);

        address worker = makeAddr("slow-worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(root);
        gov.vote(id, true);
        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);

        (, , , , , , , , , uint256 eta, ) = gov.proposals(id);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.TimelockNotElapsed.selector, id, eta)
        );
        gov.execute(id);

        vm.warp(eta + 1);
        gov.execute(id);
        assertEq(registry.getNode(worker).account, worker);
    }

    function test_setTimingBoundsAndEffect() public {
        vm.prank(root);
        gov.setTiming(1 hours, 0);

        address worker = makeAddr("fast-timing");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        (, , , , , , , , uint256 deadline, uint256 eta, ) = gov.proposals(id);
        assertEq(deadline, block.timestamp + 1 hours);
        assertEq(eta, deadline);

        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.InvalidTiming.selector, 30 minutes, 0)
        );
        vm.prank(root);
        gov.setTiming(30 minutes, 0);

        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.InvalidTiming.selector, 1 days, 31 days)
        );
        vm.prank(root);
        gov.setTiming(1 days, 31 days);

        address stranger = makeAddr("timing-stranger");
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.NotHumanRoot.selector, stranger)
        );
        vm.prank(stranger);
        gov.setTiming(2 days, 1 days);
    }

    /// Parameter changes can route through governance itself — but only High tier,
    /// so agent seats can never re-weight the electorate on a low-tier vote.
    function test_selfTargetRequiresHighTier() public {
        bytes memory data = abi.encodeCall(GovernanceModule.setQuorumYes, (3));
        vm.expectRevert(GovernanceModule.SelfTargetNotHighTier.selector);
        gov.propose(GovernanceModule.Tier.Low, address(gov), data);
    }

    function test_governanceCanRetuneItselfHighTier() public {
        bytes memory data = abi.encodeCall(GovernanceModule.setTiming, (2 days, 12 hours));
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(gov), data);

        vm.prank(root);
        gov.vote(id, true);
        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);
        gov.execute(id);

        assertEq(gov.votingPeriod(), 2 days);
        assertEq(gov.highTierTimelock(), 12 hours);
    }

    function test_totalsTrackSeatChanges() public {
        // setUp: root 2 (constructor) + voter1 1 + voter2 1 humans, agent 1.
        assertEq(gov.totalVotingPower(), 5);
        assertEq(gov.totalHumanVotingPower(), 4);

        vm.prank(root);
        gov.setVotingPower(voter1, 3, GovernanceModule.SeatRole.Human);
        assertEq(gov.totalVotingPower(), 7);
        assertEq(gov.totalHumanVotingPower(), 6);

        // Revoke and reclassify.
        vm.startPrank(root);
        gov.setVotingPower(voter1, 0, GovernanceModule.SeatRole.None);
        gov.setVotingPower(agent, 2, GovernanceModule.SeatRole.Human);
        vm.stopPrank();
        assertEq(gov.totalVotingPower(), 5);
        assertEq(gov.totalHumanVotingPower(), 5);
        assertEq(uint8(gov.seatRole(voter1)), uint8(GovernanceModule.SeatRole.None));
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
