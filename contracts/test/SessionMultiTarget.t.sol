// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @notice Multi-target session allowlists (PRD F0.7).
contract SessionMultiTargetTest is Test {
    uint256 internal constant ONE = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal sessionKey = makeAddr("sessionKey");
    address internal vendorA = makeAddr("vendorA");
    address internal vendorB = makeAddr("vendorB");
    address internal vendorC = makeAddr("vendorC");

    OrgRegistry internal registry;
    Treasury internal treasury;
    EscalationRouter internal router;
    SessionRegistry internal sessions;

    /// @dev Resolved in setUp: reading it inline would consume the next vm.prank.
    uint256 internal allScopes;
    function setUp() public {
        MockUSDC usdc = new MockUSDC();
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(vendorA, true);
        whitelist.setAllowed(vendorB, true);
        whitelist.setAllowed(vendorC, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(100 * ONE);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        treasury = new Treasury(address(registry), address(usdc), address(router));
        router.setTreasury(address(treasury));

        sessions = new SessionRegistry(root);
        vm.prank(root);
        sessions.setIssuer(address(this));
        router.setSessionRegistry(address(sessions));

        usdc.mint(address(this), 10_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.deposit(1_000 * ONE);
        treasury.streamAllowance(worker, 500 * ONE, 1);
        allScopes = sessions.SCOPE_ALL();
    }

    function _pin(address[] memory targets) internal returns (uint256) {
        return sessions.issueScoped(
            worker, sessionKey, uint64(block.timestamp + 1 hours), allScopes, 200 * ONE, targets
        );
    }

    function test_multiTargetSessionAllowsEachPinnedTarget() public {
        address[] memory targets = new address[](2);
        targets[0] = vendorA;
        targets[1] = vendorB;
        _pin(targets);

        vm.prank(sessionKey);
        (, Verdict a) = router.propose(worker, vendorA, 10 * ONE, "");
        assertEq(uint8(a), uint8(Verdict.ALLOW));

        vm.prank(sessionKey);
        (, Verdict b) = router.propose(worker, vendorB, 10 * ONE, "");
        assertEq(uint8(b), uint8(Verdict.ALLOW));
    }

    function test_multiTargetSessionBlocksUnpinnedTarget() public {
        address[] memory targets = new address[](2);
        targets[0] = vendorA;
        targets[1] = vendorB;
        _pin(targets);

        // vendorC passes the whitelist policy but is outside the session pin.
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscalationRouter.SessionTargetDenied.selector, worker, vendorC, vendorA
            )
        );
        router.propose(worker, vendorC, 10 * ONE, "");
    }

    function test_emptyPinAllowsAnyPolicyAllowedTarget() public {
        address[] memory targets = new address[](0);
        _pin(targets);

        vm.prank(sessionKey);
        (, Verdict a) = router.propose(worker, vendorA, 10 * ONE, "");
        assertEq(uint8(a), uint8(Verdict.ALLOW));

        vm.prank(sessionKey);
        (, Verdict c) = router.propose(worker, vendorC, 10 * ONE, "");
        assertEq(uint8(c), uint8(Verdict.ALLOW));
    }

    /// keyLimits reports only the first pin, so consumers that ignore
    /// isTargetAllowed deny extra targets rather than allowing everything.
    function test_keyLimitsFailsClosedForMultiTarget() public {
        address[] memory targets = new address[](2);
        targets[0] = vendorA;
        targets[1] = vendorB;
        _pin(targets);

        (bool valid, uint256 maxValue, address reported,) = sessions.keyLimits(worker, sessionKey);
        assertTrue(valid);
        assertEq(maxValue, 200 * ONE);
        assertEq(reported, vendorA, "first pin reported, never address(0)");

        assertTrue(sessions.isTargetAllowed(worker, sessionKey, vendorB));
        assertFalse(sessions.isTargetAllowed(worker, sessionKey, vendorC));
    }

    function test_duplicateTargetsAreDeduped() public {
        address[] memory targets = new address[](3);
        targets[0] = vendorA;
        targets[1] = vendorA;
        targets[2] = vendorB;
        uint256 id = _pin(targets);

        address[] memory stored = sessions.allowedTargetsOf(id);
        assertEq(stored.length, 2);
        assertEq(stored[0], vendorA);
        assertEq(stored[1], vendorB);
    }

    function test_revokedMultiTargetSessionAllowsNothing() public {
        address[] memory targets = new address[](1);
        targets[0] = vendorA;
        uint256 id = _pin(targets);

        vm.prank(root);
        sessions.revoke(id);

        assertFalse(sessions.isTargetAllowed(worker, sessionKey, vendorA));
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.InvalidSession.selector, worker, sessionKey)
        );
        router.propose(worker, vendorA, 10 * ONE, "");
    }

    function test_singleTargetIssueStillPinsExactly() public {
        sessions.issue(
            worker, sessionKey, uint64(block.timestamp + 1 hours), allScopes, 200 * ONE, vendorA
        );
        assertTrue(sessions.isTargetAllowed(worker, sessionKey, vendorA));
        assertFalse(sessions.isTargetAllowed(worker, sessionKey, vendorB));
    }
}
