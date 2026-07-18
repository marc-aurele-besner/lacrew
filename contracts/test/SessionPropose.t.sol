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

contract SessionProposeTest is Test {
    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");
    address internal sessionKey = makeAddr("sessionKey");
    address internal stranger = makeAddr("stranger");

    OrgRegistry internal registry;
    SessionRegistry internal sessions;
    EscalationRouter internal router;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(100 ether);
        spendCap.setAgentCap(manager, 300 ether);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        sessions = new SessionRegistry(root);
        router.setSessionRegistry(address(sessions));
    }

    function _issueSession(uint64 ttl) internal returns (uint256 sessionId) {
        vm.prank(root);
        sessionId = sessions.issue(
            worker,
            sessionKey,
            uint64(block.timestamp + ttl),
            bytes32("scopes"),
            type(uint256).max,
            address(0)
        );
    }

    function test_strangerCannotProposeWithoutSession() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.InvalidSession.selector, worker, stranger)
        );
        router.propose(worker, goodTarget, 50 ether, "");
    }

    function test_validSessionCanPropose() public {
        _issueSession(1 hours);
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 50 ether, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_revokedSessionCannotPropose() public {
        uint256 id = _issueSession(1 hours);
        vm.prank(root);
        sessions.revoke(id);

        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.InvalidSession.selector, worker, sessionKey)
        );
        router.propose(worker, goodTarget, 50 ether, "");
    }

    function test_expiredSessionCannotPropose() public {
        _issueSession(1 hours);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(EscalationRouter.InvalidSession.selector, worker, sessionKey)
        );
        router.propose(worker, goodTarget, 50 ether, "");
    }

    function test_agentAddressCanProposeWithoutSession() public {
        // Future AA path: agent EOA signs for itself.
        vm.prank(worker);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 50 ether, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
    }

    function test_validSessionCanEscalate() public {
        _issueSession(1 hours);
        vm.prank(sessionKey);
        (uint256 intentId, Verdict verdict) = router.propose(worker, goodTarget, 150 ether, "");
        assertEq(uint8(verdict), uint8(Verdict.ESCALATE));
        assertEq(intentId, 1);

        vm.prank(manager);
        router.resolve(intentId, true);

        (, , , , , bool resolved, bool approved) = router.intents(intentId);
        assertTrue(resolved);
        assertTrue(approved);
    }
}
