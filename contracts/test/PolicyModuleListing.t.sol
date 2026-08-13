// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {MarketplacePayments} from "../src/MarketplacePayments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {TimeWindowPolicy} from "../src/policies/TimeWindowPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @title Buying a policy module is not installing one (PRD F3.1)
/// @notice A `policyModule` marketplace listing sells a payload; what an agent
///         is allowed to do still changes only when governance executes a bind.
///         These tests pin the seam end to end on the enforcing contracts:
///         settling in USDC leaves the node's stack exactly as the org voted,
///         deploying the would-be stack is inert, and only `execute` puts the
///         bought module in the path of `check`.
contract PolicyModuleListingTest is Test {
    address internal root = makeAddr("root");
    address internal worker = makeAddr("worker");
    address internal target = makeAddr("target");
    address internal seller = makeAddr("seller");
    address internal platform = makeAddr("platform");

    OrgRegistry internal registry;
    EscalationRouter internal router;
    GovernanceModule internal gov;
    MockUSDC internal usdc;
    MarketplacePayments internal market;

    PolicyStack internal votedStack;
    WhitelistPolicy internal whitelist;
    SpendCapPolicy internal spendCap;
    /// The listed module: already deployed, as a v1 listing requires.
    TimeWindowPolicy internal listedModule;

    uint256 internal constant ONE = 1e6;
    bytes32 internal constant LISTING = keccak256("policy-module:office-hours");

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, root);

        whitelist = new WhitelistPolicy();
        whitelist.setAllowed(target, true);
        spendCap = new SpendCapPolicy(100 ether);

        IPolicyModule[] memory voted = new IPolicyModule[](2);
        voted[0] = whitelist;
        voted[1] = spendCap;
        votedStack = new PolicyStack(voted);

        router = new EscalationRouter(address(registry), address(votedStack));
        router.setNodePolicy(worker, address(votedStack));

        // Governor last: from here a stack change is a vote, which is the whole
        // premise the marketplace path has to respect.
        gov = new GovernanceModule(root, 2);
        router.setGovernor(address(gov));
        vm.prank(root);
        registry.setGovernor(address(gov));

        // A window that is shut for all but one second of the day. The module a
        // buyer attaches has to be able to DENY for these tests to say anything:
        // a guardrail that could only escalate would never show the seam.
        listedModule = new TimeWindowPolicy(1, 2);

        usdc = new MockUSDC();
        market = new MarketplacePayments(address(usdc), platform, root, 2000);
        usdc.mint(worker, 1_000 * ONE);
        vm.prank(worker);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(seller);
        market.registerListing(LISTING, 25 * ONE);

        // Midday, so the listed window is shut whenever a test asks.
        vm.warp((block.timestamp / 1 days + 1) * 1 days + 12 hours);
    }

    /// Buying the listing settles USDC and grants the payload. It binds nothing.
    function test_purchaseLeavesTheVotedStackInForce() public {
        vm.prank(worker);
        market.purchase(LISTING, 25 * ONE);

        assertTrue(market.hasPurchased(LISTING, worker), "receipt is what a buyer gets");
        assertEq(market.owed(seller), 20 * ONE, "seller nets 80%");
        assertEq(address(router.policyOf(worker)), address(votedStack), "stack unchanged");

        // The bought module is not consulted: the call the voted stack allows
        // still goes through, at a time of day the module would DENY.
        (uint256 intentId, Verdict verdict) = router.propose(worker, target, 1 ether, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
        assertEq(uint8(listedModule.check(worker, target, 1 ether, "")), uint8(Verdict.DENY));
    }

    /// The orchestrator deploys the would-be stack before proposing. A deploy
    /// carries no authority — until the bind executes it is a contract nobody
    /// has pointed at.
    function test_deployingTheAttachedStackChangesNothing() public {
        vm.prank(worker);
        market.purchase(LISTING, 25 * ONE);
        PolicyStack attached = _stackWithListedModule();

        assertEq(address(router.policyOf(worker)), address(votedStack));
        (, Verdict verdict) = router.propose(worker, target, 1 ether, "");
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
        assertTrue(address(attached) != address(votedStack));
    }

    /// Only `execute` puts the bought module in the path — and once it is there,
    /// its DENY is final: it sits behind the modules the org already voted, and
    /// first DENY wins.
    function test_moduleEnforcedOnlyAfterGovernanceExecutes() public {
        vm.prank(worker);
        market.purchase(LISTING, 25 * ONE);
        PolicyStack attached = _stackWithListedModule();

        uint256 id = gov.propose(
            GovernanceModule.Tier.High,
            address(router),
            abi.encodeCall(EscalationRouter.setNodePolicy, (worker, address(attached)))
        );
        vm.prank(root);
        gov.vote(id, true);

        // Still the voted stack while the timelock runs: a pending proposal is
        // not a policy.
        assertEq(address(router.policyOf(worker)), address(votedStack));

        (, , , , , , , , , uint256 eta, ) = gov.proposals(id);
        vm.warp(eta + 1);
        // Back to midday so the module's verdict is about the window, not about
        // where the timelock happened to land.
        vm.warp((block.timestamp / 1 days + 1) * 1 days + 12 hours);
        gov.execute(id);

        assertEq(address(router.policyOf(worker)), address(attached), "bound by the vote");
        assertEq(
            uint8(IPolicyModule(address(attached)).check(worker, target, 1 ether, "")),
            uint8(Verdict.DENY),
            "check now includes the bought module"
        );
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.UnexpectedVerdict.selector, Verdict.DENY)
        );
        router.propose(worker, target, 1 ether, "");
    }

    /// The attach path appends. A stack that replaced the org's modules could
    /// sell a loosening dressed as a guardrail, so the ordering is asserted
    /// rather than assumed: the voted modules keep their places.
    function test_attachedStackKeepsTheVotedModulesAndTheirOrder() public {
        PolicyStack attached = _stackWithListedModule();
        assertEq(attached.moduleCount(), 3);
        assertEq(address(attached.modules(0)), address(whitelist));
        assertEq(address(attached.modules(1)), address(spendCap));
        assertEq(address(attached.modules(2)), address(listedModule));

        // Whatever the bought module says, a target the whitelist refuses is
        // still refused — the module was added behind the org's own rules.
        address stranger = makeAddr("stranger");
        assertEq(
            uint8(IPolicyModule(address(attached)).check(worker, stranger, 1 ether, "")),
            uint8(Verdict.DENY)
        );
    }

    /// What the orchestrator's attach path builds: the node's current members
    /// in order, with the listed module appended.
    function _stackWithListedModule() internal returns (PolicyStack) {
        uint256 count = votedStack.moduleCount();
        IPolicyModule[] memory members = new IPolicyModule[](count + 1);
        for (uint256 i = 0; i < count; i++) {
            members[i] = votedStack.modules(i);
        }
        members[count] = listedModule;
        return new PolicyStack(members);
    }
}
