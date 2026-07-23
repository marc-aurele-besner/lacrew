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

/// @dev A session key issued with a rate limit may propose at most `maxProposals`
///      times per `ratePeriod`; EscalationRouter records each propose and reverts
///      the one that would exceed it. The counter resets when the window elapses.
contract SessionRateLimitTest is Test {
    uint256 internal constant USDC = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal target = makeAddr("target");
    address internal sessionKey = makeAddr("sessionKey");
    address internal stranger = makeAddr("stranger");

    OrgRegistry internal registry;
    SessionRegistry internal sessions;
    EscalationRouter internal router;
    uint256 internal allScopes;

    function setUp() public {
        vm.warp(1_000_000);

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
        // Without this the registry no-ops recordProposal; the rate limit is
        // opt-in exactly as session enforcement is opt-in on the router.
        vm.prank(root);
        sessions.setEscalationRouter(address(router));
        allScopes = sessions.SCOPE_ALL();
    }

    /// Issue a session for `worker` with `maxProposals` per `ratePeriod`.
    function _issueRateLimited(uint32 maxProposals, uint32 ratePeriod) internal {
        address[] memory targets;
        vm.prank(root);
        sessions.issueScopedTimed(
            worker,
            sessionKey,
            uint64(block.timestamp + 30 days),
            allScopes,
            200 * USDC,
            targets,
            0,
            0,
            maxProposals,
            ratePeriod
        );
    }

    /// An ESCALATE propose (75 > 50 cap) — records against the rate limit without
    /// needing a funded treasury.
    function _propose() internal returns (Verdict verdict) {
        vm.prank(sessionKey);
        (, verdict) = router.propose(worker, target, 75 * USDC, "");
    }

    function test_proposalsWithinLimitAllowed() public {
        _issueRateLimited(3, 1 hours);
        assertEq(uint8(_propose()), uint8(Verdict.ESCALATE));
        assertEq(uint8(_propose()), uint8(Verdict.ESCALATE));
        assertEq(uint8(_propose()), uint8(Verdict.ESCALATE));
        (,, , uint32 count) = sessions.rateLimits(_sessionId());
        assertEq(count, 3);
    }

    function test_proposalOverLimitReverts() public {
        _issueRateLimited(2, 1 hours);
        _propose();
        _propose();
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionRegistry.RateLimitExceeded.selector, worker, sessionKey, uint32(2))
        );
        router.propose(worker, target, 75 * USDC, "");
    }

    function test_counterResetsAfterWindow() public {
        _issueRateLimited(2, 1 hours);
        _propose();
        _propose();
        // Next would exceed — but after the window it is a fresh one.
        vm.warp(block.timestamp + 1 hours);
        assertEq(uint8(_propose()), uint8(Verdict.ESCALATE));
        (,, , uint32 count) = sessions.rateLimits(_sessionId());
        assertEq(count, 1, "window reset to a single proposal");
    }

    function test_noRateLimitIsUnlimited() public {
        _issueRateLimited(0, 0); // disabled
        for (uint256 i = 0; i < 10; i++) {
            assertEq(uint8(_propose()), uint8(Verdict.ESCALATE));
        }
    }

    function test_recordProposalRejectsNonRouter() public {
        _issueRateLimited(2, 1 hours);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.NotAuthorized.selector, stranger));
        sessions.recordProposal(worker, sessionKey);
    }

    function test_invalidRateLimitRejectedAtIssue() public {
        address[] memory targets;
        // A cap with no period.
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(SessionRegistry.InvalidRateLimit.selector, uint32(5), uint32(0))
        );
        sessions.issueScopedTimed(
            worker, sessionKey, uint64(block.timestamp + 1 days), allScopes, 200 * USDC, targets, 0, 0, 5, 0
        );
        // A period with no cap.
        vm.prank(root);
        vm.expectRevert(
            abi.encodeWithSelector(SessionRegistry.InvalidRateLimit.selector, uint32(0), uint32(3600))
        );
        sessions.issueScopedTimed(
            worker, sessionKey, uint64(block.timestamp + 1 days), allScopes, 200 * USDC, targets, 0, 0, 0, 3600
        );
    }

    function _sessionId() internal view returns (uint256) {
        return sessions.activeKeySession(worker, sessionKey);
    }
}
