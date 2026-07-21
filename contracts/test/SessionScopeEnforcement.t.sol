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

/// @dev What a session key may *do*, as opposed to how much it may move
///      (`SessionScope.t.sol`) or where it may send it (`SessionMultiTarget.t.sol`).
contract SessionScopeEnforcementTest is Test {
    uint256 internal constant USDC = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal target = makeAddr("target");
    address internal sessionKey = makeAddr("sessionKey");

    OrgRegistry internal registry;
    SessionRegistry internal sessions;
    EscalationRouter internal router;

    uint256 internal proposeScope;
    uint256 internal spendScope;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(target, true);
        // Cap above the worker's asks, so ALLOW is the default verdict and the
        // scope check is the only thing that can stop settlement.
        SpendCapPolicy spendCap = new SpendCapPolicy(500 * USDC);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        sessions = new SessionRegistry(root);
        router.setSessionRegistry(address(sessions));

        proposeScope = sessions.SCOPE_PROPOSE_INTENT();
        spendScope = sessions.SCOPE_SPEND_WHITELIST();
    }

    function _issue(uint256 scopeMask) internal {
        vm.prank(root);
        sessions.issue(
            worker, sessionKey, uint64(block.timestamp + 1 hours), scopeMask, type(uint256).max, address(0)
        );
    }

    function test_fullScopeSettlesImmediately() public {
        _issue(proposeScope | spendScope);
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, target, 10 * USDC, "");
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
        assertEq(intentId, 0);
    }

    /// The point of the split: a key that may raise intents but not settle them
    /// cannot move money on its own, even when policy says ALLOW.
    function test_proposeScopeAloneCannotSettleAnAllow() public {
        _issue(proposeScope);
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscalationRouter.SessionScopeDenied.selector, worker, spendScope, proposeScope
            )
        );
        router.propose(worker, target, 10 * USDC, "");
    }

    function test_spendScopeAloneCannotPropose() public {
        _issue(spendScope);
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscalationRouter.SessionScopeDenied.selector, worker, proposeScope, spendScope
            )
        );
        router.propose(worker, target, 10 * USDC, "");
    }

    /// The agent acting for itself is not using a session, so no scope narrows it.
    function test_agentActingForItselfIsUnscoped() public {
        _issue(proposeScope);
        vm.prank(worker);
        (, Verdict verdict) = router.propose(worker, target, 10 * USDC, "");
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_emptyScopeMaskIsRejectedAtIssue() public {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.InvalidScopeMask.selector, 0));
        sessions.issue(
            worker, sessionKey, uint64(block.timestamp + 1 hours), 0, type(uint256).max, address(0)
        );
    }

    /// A bit this version does not know is far more likely a caller encoding
    /// against a newer vocabulary than a grant anyone intended.
    function test_unknownScopeBitIsRejectedAtIssue() public {
        uint256 bogus = proposeScope | (1 << 200);
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.InvalidScopeMask.selector, bogus));
        sessions.issue(
            worker, sessionKey, uint64(block.timestamp + 1 hours), bogus, type(uint256).max, address(0)
        );
    }

    function test_keyLimitsReportsTheGrantedMask() public {
        _issue(proposeScope);
        (bool valid,,, uint256 scopeMask) = sessions.keyLimits(worker, sessionKey);
        assertTrue(valid);
        assertEq(scopeMask, proposeScope);
    }

    /// A revoked key reports no scope, so a consumer reading the mask alone
    /// still fails closed.
    function test_revokedSessionReportsNoScope() public {
        _issue(proposeScope | spendScope);
        // Read before the prank — an external call would consume it.
        uint256 sessionId = sessions.activeKeySession(worker, sessionKey);
        vm.prank(root);
        sessions.revoke(sessionId);
        (bool valid,,, uint256 scopeMask) = sessions.keyLimits(worker, sessionKey);
        assertFalse(valid);
        assertEq(scopeMask, 0);
    }
}
