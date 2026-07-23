// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @dev A session key issued with a daily window may only propose inside it,
///      enforced onchain by EscalationRouter — the flow's time-window scope the
///      key could not carry before.
contract SessionTimeWindowTest is Test {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant DAY = 1 days;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal target = makeAddr("target");
    address internal sessionKey = makeAddr("sessionKey");

    OrgRegistry internal registry;
    SessionRegistry internal sessions;
    EscalationRouter internal router;
    uint256 internal allScopes;

    function setUp() public {
        // A fixed midnight (tod = 0) so warps land on a known time of day.
        vm.warp(1000 * DAY);

        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(target, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(50 * USDC);
        spendCap.setAgentCap(manager, 200 * USDC);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        sessions = new SessionRegistry(root);
        router.setSessionRegistry(address(sessions));
        allScopes = sessions.SCOPE_ALL();
    }

    /// Issue a session for `worker` valid for two days, pinned to a daily window.
    function _issueTimed(uint32 windowStart, uint32 windowEnd) internal {
        address[] memory targets;
        vm.prank(root);
        sessions.issueScopedTimed(
            worker,
            sessionKey,
            uint64(block.timestamp + 2 * DAY),
            allScopes,
            200 * USDC,
            targets,
            windowStart,
            windowEnd
        );
    }

    function test_proposeInsideWindowAllowed() public {
        _issueTimed(9 hours, 17 hours);
        vm.warp(1000 * DAY + 12 hours); // tod = 12:00, inside
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, target, 40 * USDC, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_proposeBeforeWindowReverts() public {
        _issueTimed(9 hours, 17 hours);
        vm.warp(1000 * DAY + 8 hours); // tod = 08:00, before
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.SessionTimeWindowDenied.selector, worker)
        );
        router.propose(worker, target, 40 * USDC, "");
    }

    function test_proposeAfterWindowReverts() public {
        _issueTimed(9 hours, 17 hours);
        vm.warp(1000 * DAY + 20 hours); // tod = 20:00, after
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.SessionTimeWindowDenied.selector, worker)
        );
        router.propose(worker, target, 40 * USDC, "");
    }

    function test_windowEndIsExclusive() public {
        _issueTimed(9 hours, 17 hours);
        vm.warp(1000 * DAY + 17 hours); // tod = 17:00 exactly, excluded
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.SessionTimeWindowDenied.selector, worker)
        );
        router.propose(worker, target, 40 * USDC, "");
    }

    function test_noWindowAllowsAnyTime() public {
        _issueTimed(0, 0); // disabled
        vm.warp(1000 * DAY + 3 hours); // tod = 03:00, would be outside any daytime window
        vm.prank(sessionKey);
        (, Verdict verdict) = router.propose(worker, target, 40 * USDC, "");
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_withinTimeWindowView() public {
        _issueTimed(9 hours, 17 hours);
        vm.warp(1000 * DAY + 12 hours);
        assertTrue(sessions.withinTimeWindow(worker, sessionKey));
        vm.warp(1000 * DAY + 20 hours);
        assertFalse(sessions.withinTimeWindow(worker, sessionKey));
    }

    function test_invalidWindowRejectedAtIssue() public {
        address[] memory targets;
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(SessionRegistry.InvalidWindow.selector, uint32(17 hours), uint32(9 hours))
        );
        sessions.issueScopedTimed(
            worker, sessionKey, uint64(block.timestamp + DAY), allScopes, 200 * USDC, targets, 17 hours, 9 hours
        );

        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(SessionRegistry.InvalidWindow.selector, uint32(1 hours), uint32(DAY + 1))
        );
        sessions.issueScopedTimed(
            worker, sessionKey, uint64(block.timestamp + DAY), allScopes, 200 * USDC, targets, 1 hours, uint32(DAY + 1)
        );
    }
}
