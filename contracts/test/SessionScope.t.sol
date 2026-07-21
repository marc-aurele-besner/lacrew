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

contract SessionScopeTest is Test {
    uint256 internal constant USDC = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");
    address internal otherTarget = makeAddr("otherTarget");
    address internal sessionKey = makeAddr("sessionKey");

    OrgRegistry internal registry;
    SessionRegistry internal sessions;
    EscalationRouter internal router;

    /// @dev Resolved in setUp: reading it inline would consume the next vm.prank.
    uint256 internal allScopes;
    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);
        whitelist.setAllowed(otherTarget, true);
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

    function _issue(uint256 maxValue, address allowedTarget) internal {
        vm.prank(root);
        sessions.issue(
            worker,
            sessionKey,
            uint64(block.timestamp + 1 hours),
            allScopes,
            maxValue,
            allowedTarget
        );
    }

    function test_sessionMaxValueAllowsUnderLimit() public {
        _issue(200 * USDC, address(0));
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 40 * USDC, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_sessionMaxValueBlocksOverLimit() public {
        _issue(100 * USDC, address(0));
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscalationRouter.SessionValueExceeded.selector, worker, 150 * USDC, 100 * USDC
            )
        );
        router.propose(worker, goodTarget, 150 * USDC, "");
    }

    function test_sessionMaxValueAllowsEscalateWithinLimit() public {
        _issue(200 * USDC, address(0));
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 75 * USDC, "");
        assertEq(uint8(verdict), uint8(Verdict.ESCALATE));
        assertEq(intentId, 1);
    }

    function test_allowedTargetBlocksOtherTarget() public {
        _issue(200 * USDC, goodTarget);
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                EscalationRouter.SessionTargetDenied.selector, worker, otherTarget, goodTarget
            )
        );
        router.propose(worker, otherTarget, 40 * USDC, "");
    }

    function test_allowedTargetAllowsPinnedTarget() public {
        _issue(200 * USDC, goodTarget);
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 40 * USDC, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_keyLimitsReportsMaxValueAndTarget() public {
        _issue(123 * USDC, goodTarget);
        (bool valid, uint256 maxValue, address allowed, uint256 scopeMask) =
            sessions.keyLimits(worker, sessionKey);
        assertTrue(valid);
        assertEq(maxValue, 123 * USDC);
        assertEq(allowed, goodTarget);
        assertEq(scopeMask, sessions.SCOPE_ALL());
    }

    function test_agentEoaBypassesSessionLimits() public {
        vm.prank(worker);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 40 * USDC, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }
}
