// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SessionScopes} from "../src/SessionScopes.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @notice The authority layer: who may wire a contract while it is being bootstrapped,
///         which contracts an agent may never aim the router at, which governance
///         actions can never ride the low tier, and how long an issuer may mint a key.
contract AuthorityHardeningTest is Test {
    uint256 internal constant ONE = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal vendor = makeAddr("vendor");
    address internal stranger = makeAddr("stranger");
    address internal sessionKey = makeAddr("sessionKey");

    MockUSDC internal usdc;
    OrgRegistry internal registry;
    Treasury internal treasury;
    EscalationRouter internal router;
    RateLimitPolicy internal rateLimit;
    WhitelistPolicy internal whitelist;
    SessionRegistry internal sessions;
    GovernanceModule internal gov;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        // A whitelist that admits the privileged contracts on purpose: the guard
        // under test must hold even when policy says yes.
        whitelist = new WhitelistPolicy();
        whitelist.setAllowed(vendor, true);
        rateLimit = new RateLimitPolicy(5, 1 hours);

        router = new EscalationRouter(address(registry), address(whitelist));
        treasury = new Treasury(address(registry), address(usdc), address(router));
        router.setTreasury(address(treasury));
        router.setRateRecorder(address(rateLimit));
        rateLimit.setRecorder(address(router));
        sessions = new SessionRegistry(root);
        router.setSessionRegistry(address(sessions));
        gov = new GovernanceModule(root, 2);

        whitelist.setAllowed(address(treasury), true);
        whitelist.setAllowed(address(router), true);
        whitelist.setAllowed(address(sessions), true);
        whitelist.setAllowed(address(rateLimit), true);

        usdc.mint(address(this), 1_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.deposit(500 * ONE);
        treasury.streamAllowance(worker, 100 * ONE, 1);
        treasury.streamAllowance(manager, 100 * ONE, 1);
    }

    // ——— RateLimitPolicy: recorder binding ———

    function test_rateLimitStrangerCannotBindRecorder() public {
        RateLimitPolicy fresh = new RateLimitPolicy(5, 1 hours);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RateLimitPolicy.NotAuthorized.selector, stranger));
        fresh.setRecorder(stranger);
    }

    function test_rateLimitStrangerCannotRecordBeforeBind() public {
        RateLimitPolicy fresh = new RateLimitPolicy(5, 1 hours);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RateLimitPolicy.NotRecorder.selector, stranger));
        fresh.record(worker);
        // The deployer still can, so unit tests and local scaffolding work unbound.
        fresh.record(worker);
    }

    function test_rateLimitBindIsOnceAndNonZero() public {
        RateLimitPolicy fresh = new RateLimitPolicy(5, 1 hours);
        vm.expectRevert(RateLimitPolicy.ZeroAddress.selector);
        fresh.setRecorder(address(0));
        fresh.setRecorder(address(router));
        vm.expectRevert(RateLimitPolicy.RecorderLocked.selector);
        fresh.setRecorder(stranger);
        // Once bound, the deployer itself is no longer a recorder.
        vm.expectRevert(abi.encodeWithSelector(RateLimitPolicy.NotRecorder.selector, address(this)));
        fresh.record(worker);
    }

    // ——— Treasury / EscalationRouter: bootstrap is the deployer's, not anyone's ———

    function test_treasuryBootstrapRefusesStrangers() public {
        Treasury fresh = new Treasury(address(registry), address(usdc), address(router));
        assertEq(fresh.deployer(), address(this));
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger));
        fresh.setGovernor(stranger);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger));
        fresh.setSpender(stranger);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger));
        fresh.setStreamer(stranger);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, stranger));
        fresh.streamAllowance(stranger, 1, 1);
        vm.stopPrank();
        // The deployer can wire it, and after that the governor owns the setters.
        fresh.setGovernor(address(gov));
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotAuthorized.selector, address(this)));
        fresh.setSpender(stranger);
    }

    function test_routerBootstrapRefusesStrangers() public {
        EscalationRouter fresh = new EscalationRouter(address(registry), address(whitelist));
        assertEq(fresh.deployer(), address(this));
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setGovernor(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setTreasury(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setSessionRegistry(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setRateRecorder(stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setNodePolicy(worker, stranger);
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, stranger));
        fresh.setNodeRateRecorder(worker, stranger);
        vm.stopPrank();
        fresh.setGovernor(address(gov));
        vm.expectRevert(abi.encodeWithSelector(EscalationRouter.NotAuthorized.selector, address(this)));
        fresh.setTreasury(stranger);
    }

    // ——— EscalationRouter: the contracts that trust the router are never targets ———

    function test_proposeRefusesTreasuryAsTargetEvenWhenWhitelisted() public {
        // Policy admits the Treasury (setUp), and the payload would spend the manager's
        // allowance to the worker using the router's spender authority.
        bytes memory drain = abi.encodeWithSignature(
            "spendAllowance(address,uint256,address)", manager, 100 * ONE, worker
        );
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.ProtectedTarget.selector, address(treasury))
        );
        router.propose(worker, address(treasury), 0, drain);
        assertEq(treasury.allowanceBalance(manager), 100 * ONE);
    }

    function test_proposeRefusesRouterSessionRegistryAndRecorder() public {
        vm.startPrank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.ProtectedTarget.selector, address(router))
        );
        router.propose(worker, address(router), 0, hex"");
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.ProtectedTarget.selector, address(sessions))
        );
        router.propose(worker, address(sessions), 0, hex"");
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.ProtectedTarget.selector, address(rateLimit))
        );
        router.propose(worker, address(rateLimit), 0, hex"");
        vm.stopPrank();
    }

    function test_proposeRefusesPerNodeRecorder() public {
        RateLimitPolicy own = new RateLimitPolicy(5, 1 hours);
        own.setRecorder(address(router));
        router.setNodeRateRecorder(worker, address(own));
        whitelist.setAllowed(address(own), true);
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.ProtectedTarget.selector, address(own))
        );
        router.propose(worker, address(own), 0, hex"");
    }

    function test_proposeStillReachesOrdinaryTargets() public {
        vm.prank(worker);
        (uint256 intentId, Verdict verdict) = router.propose(worker, vendor, 40 * ONE, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
        assertEq(usdc.balanceOf(vendor), 40 * ONE);
    }

    // ——— GovernanceModule: a governor transfer is never low tier ———

    function test_lowTierCannotTransferGovernor() public {
        bytes memory data = abi.encodeCall(Treasury.setGovernor, (stranger));
        vm.expectRevert(GovernanceModule.GovernorTransferNotHighTier.selector);
        gov.propose(GovernanceModule.Tier.Low, address(treasury), data);
        // Other low-tier calls are unaffected.
        gov.propose(GovernanceModule.Tier.Low, address(treasury), abi.encodeCall(Treasury.setStreamer, (stranger)));
    }

    function test_highTierCanTransferGovernor() public {
        treasury.setGovernor(address(gov));
        bytes memory data = abi.encodeCall(Treasury.setGovernor, (stranger));
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(treasury), data);
        vm.prank(root);
        gov.vote(id, true);
        // Root is the whole human electorate, so unanimity skips the timelock.
        gov.execute(id);
        assertEq(treasury.governor(), stranger);
    }

    // ——— SessionRegistry: issuer-minted keys are bounded in lifetime ———

    function test_issuerCannotOutliveMaxTtl() public {
        address issuer = makeAddr("issuer");
        vm.prank(root);
        sessions.setIssuer(issuer);
        uint64 tooFar = uint64(block.timestamp + 30 days + 1);
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionRegistry.ExpiryExceedsIssuerTtl.selector, tooFar, uint64(block.timestamp + 30 days)
            )
        );
        sessions.issue(worker, sessionKey, tooFar, SessionScopes.ALL, 1, address(0));
        // At the ceiling it mints; the root is not bound by it.
        vm.prank(issuer);
        sessions.issue(worker, sessionKey, uint64(block.timestamp + 30 days), SessionScopes.ALL, 1, address(0));
        vm.prank(root);
        sessions.issue(manager, sessionKey, tooFar, SessionScopes.ALL, 1, address(0));
    }

    function test_rootTunesMaxIssuerTtl() public {
        address issuer = makeAddr("issuer");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.NotAuthorized.selector, stranger));
        sessions.setMaxIssuerTtl(1 hours);
        vm.prank(root);
        vm.expectRevert(SessionRegistry.ZeroTtl.selector);
        sessions.setMaxIssuerTtl(0);
        vm.startPrank(root);
        sessions.setMaxIssuerTtl(1 hours);
        sessions.setIssuer(issuer);
        vm.stopPrank();
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionRegistry.ExpiryExceedsIssuerTtl.selector,
                uint64(block.timestamp + 2 hours),
                uint64(block.timestamp + 1 hours)
            )
        );
        sessions.issue(worker, sessionKey, uint64(block.timestamp + 2 hours), SessionScopes.ALL, 1, address(0));
    }
}
