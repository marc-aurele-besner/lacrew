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

        _admitHuman(gov, voter1, 1);
        _admitHuman(gov, voter2, 1);

        vm.startPrank(root);
        gov.setVotingPower(agent, 1, GovernanceModule.SeatRole.Agent);
        gov.setQuorumYes(2);
        gov.setQuorumHumanYes(1);
        vm.stopPrank();
    }

    /// Seat a human the only way the module allows once an org has one: a High-tier
    /// proposal on the module itself, carried by the root's own human weight. Warps
    /// past the eta rather than relying on the unanimity fast path, so the helper
    /// works whether or not the humans already seated have all voted.
    function _admitHuman(GovernanceModule g, address who, uint256 power) internal {
        uint256 id = g.propose(
            GovernanceModule.Tier.High,
            address(g),
            abi.encodeCall(GovernanceModule.admitHuman, (who, power))
        );
        vm.prank(root);
        g.vote(id, true);
        (, , , , , , , , , uint256 eta, ) = g.proposals(id);
        vm.warp(eta + 1);
        g.execute(id);
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
        _admitHuman(gov, heavy, 2);

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
        assertEq(gov.humanSeatCount(), 3);

        // Re-weighting a seated human is seat admin too — same governance path.
        _admitHuman(gov, voter1, 3);
        assertEq(gov.totalVotingPower(), 7);
        assertEq(gov.totalHumanVotingPower(), 6);
        assertEq(gov.humanSeatCount(), 3);

        // Revoke and reclassify.
        _removeHuman(gov, voter1);
        _admitHuman(gov, agent, 2);
        assertEq(gov.totalVotingPower(), 5);
        assertEq(gov.totalHumanVotingPower(), 5);
        assertEq(gov.humanSeatCount(), 3);
        assertEq(uint8(gov.seatRole(voter1)), uint8(GovernanceModule.SeatRole.None));
    }

    /// Seat admin over humans is constitutional: a private key — the root's included —
    /// cannot admit a partner, so nobody joins the electorate unseen by the humans in it.
    function test_rootCannotAdmitHumanDirectly() public {
        address partner = makeAddr("partner");
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.NotGovernance.selector, root));
        gov.admitHuman(partner, 2);

        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.NotGovernance.selector, root));
        gov.setVotingPower(partner, 2, GovernanceModule.SeatRole.Human);

        // And the root cannot quietly demote one either.
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.NotGovernance.selector, root));
        gov.setVotingPower(voter1, 0, GovernanceModule.SeatRole.None);
    }

    /// Agent seats stay the root's to administer — the bootstrap path this module has
    /// always had, and the one the seat-admin gate deliberately does not close.
    function test_rootStillAdministersAgentSeats() public {
        address helper = makeAddr("agent-helper");
        vm.prank(root);
        gov.setVotingPower(helper, 4, GovernanceModule.SeatRole.Agent);
        assertEq(gov.votingPower(helper), 4);
        assertEq(gov.humanSeatCount(), 3);
    }

    /// Two humans, either one enough to stop a proposal: the safety valve is shared,
    /// not the root's to hold alone.
    function test_eitherHumanCanVetoHighTier() public {
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (makeAddr("two-human-veto"), IOrgRegistry.NodeKind.WorkerAgent, root)
        );

        uint256 first = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(voter1);
        gov.veto(first);
        (, , , , , , , , , , GovernanceModule.ProposalState s1) = gov.proposals(first);
        assertEq(uint8(s1), uint8(GovernanceModule.ProposalState.Vetoed));

        uint256 second = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(voter2);
        gov.veto(second);
        (, , , , , , , , , , GovernanceModule.ProposalState s2) = gov.proposals(second);
        assertEq(uint8(s2), uint8(GovernanceModule.ProposalState.Vetoed));
    }

    /// Firing one human leaves the others seated — with their veto intact.
    function test_removeHumanLeavesTheOthersSeated() public {
        _removeHuman(gov, voter1);
        assertEq(gov.humanSeatCount(), 2);
        assertEq(gov.votingPower(voter1), 0);
        assertEq(uint8(gov.seatRole(voter1)), uint8(GovernanceModule.SeatRole.None));

        uint256 id = gov.propose(
            GovernanceModule.Tier.High,
            address(registry),
            abi.encodeCall(
                OrgRegistry.addNode,
                (makeAddr("after-removal"), IOrgRegistry.NodeKind.WorkerAgent, root)
            )
        );
        vm.prank(voter2);
        gov.veto(id);
        (, , , , , , , , , , GovernanceModule.ProposalState state) = gov.proposals(id);
        assertEq(uint8(state), uint8(GovernanceModule.ProposalState.Vetoed));

        // A revoked seat is a stranger: no vote, and no veto either.
        uint256 next = gov.propose(GovernanceModule.Tier.Low, address(registry), "");
        vm.prank(voter1);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.NotHumanSeat.selector, voter1)
        );
        gov.veto(next);
    }

    /// The last human cannot be fired — by governance, by the root, or by reclassifying
    /// the seat into an agent one. Agent seats never satisfy high-tier final say, so an
    /// org with no human left would be frozen, not merely agent-run.
    function test_cannotRemoveLastHumanSeat() public {
        _removeHuman(gov, voter1);
        _removeHuman(gov, voter2);
        assertEq(gov.humanSeatCount(), 1);

        uint256 id = gov.propose(
            GovernanceModule.Tier.High,
            address(gov),
            abi.encodeCall(GovernanceModule.removeHuman, (root))
        );
        vm.prank(root);
        gov.vote(id, true);
        (, , , , , , , , , uint256 eta, ) = gov.proposals(id);
        vm.warp(eta + 1);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.ActionFailed.selector, address(gov))
        );
        gov.execute(id);

        // Nor by demoting the seat to an agent one through setVotingPower.
        uint256 demote = gov.propose(
            GovernanceModule.Tier.High,
            address(gov),
            abi.encodeCall(
                GovernanceModule.setVotingPower,
                (root, 2, GovernanceModule.SeatRole.Agent)
            )
        );
        vm.prank(root);
        gov.vote(demote, true);
        (, , , , , , , , , uint256 eta2, ) = gov.proposals(demote);
        vm.warp(eta2 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.ActionFailed.selector, address(gov))
        );
        gov.execute(demote);

        assertEq(gov.humanSeatCount(), 1);
        assertEq(uint8(gov.seatRole(root)), uint8(GovernanceModule.SeatRole.Human));
    }

    /// High tier still needs a human yes after the roster grows: more humans raise the
    /// bar for unanimity, they do not let agent weight stand in for a human.
    function test_secondHumanRaisesUnanimityBarNotAgentAuthority() public {
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (makeAddr("still-needs-human"), IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(agent);
        gov.vote(id, true);
        (, , , , , , , , , uint256 eta, ) = gov.proposals(id);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.QuorumNotMet.selector, id));
        gov.execute(id);

        // Root alone is a human yes, but not all of the human weight — the timelock
        // holds for the partners who have not spoken.
        vm.prank(root);
        gov.vote(id, true);
        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.TimelockNotElapsed.selector, id, eta)
        );
        gov.execute(id);

        vm.prank(voter1);
        gov.vote(id, true);
        vm.prank(voter2);
        gov.vote(id, true);
        gov.execute(id);
        assertEq(registry.getNode(makeAddr("still-needs-human")).account, makeAddr("still-needs-human"));
    }

    /// An org deployed with no seeded root weight still seats its first human: without
    /// this carve-out a `rootPower_ = 0` module would be born with no one able to act.
    function test_seatlessOrgLetsRootSeatTheFirstHuman() public {
        address solo = makeAddr("unseeded-root");
        GovernanceModule bare = new GovernanceModule(solo, 0);
        assertEq(bare.humanSeatCount(), 0);

        vm.prank(solo);
        bare.admitHuman(solo, 2);
        assertEq(bare.humanSeatCount(), 1);
        assertEq(bare.totalHumanVotingPower(), 2);

        // The carve-out closes behind it: the next human is governance's to admit.
        address partner = makeAddr("second-of-two");
        vm.prank(solo);
        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.NotGovernance.selector, solo));
        bare.admitHuman(partner, 1);
    }

    /// Revoke a human through governance. Root's weight carries it; the warp keeps the
    /// helper valid whether or not the fast path applies.
    function _removeHuman(GovernanceModule g, address who) internal {
        uint256 id = g.propose(
            GovernanceModule.Tier.High,
            address(g),
            abi.encodeCall(GovernanceModule.removeHuman, (who))
        );
        vm.prank(root);
        g.vote(id, true);
        (, , , , , , , , , uint256 eta, ) = g.proposals(id);
        vm.warp(eta + 1);
        g.execute(id);
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
