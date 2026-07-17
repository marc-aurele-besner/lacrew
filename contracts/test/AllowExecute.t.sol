// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

contract AllowExecuteTest is Test {
    uint256 internal constant ONE = 1e6;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal vendor = makeAddr("vendor");

    MockUSDC internal usdc;
    OrgRegistry internal registry;
    Treasury internal treasury;
    RateLimitPolicy internal rateLimit;
    EscalationRouter internal router;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(vendor, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(100 * ONE);
        spendCap.setAgentCap(manager, 300 * ONE);
        spendCap.setAgentCap(root, type(uint256).max);
        rateLimit = new RateLimitPolicy(2, 1 hours);

        IPolicyModule[] memory modules = new IPolicyModule[](3);
        modules[0] = whitelist;
        modules[1] = spendCap;
        modules[2] = rateLimit;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        treasury = new Treasury(address(registry), address(usdc), address(router));
        router.setTreasury(address(treasury));
        router.setRateRecorder(address(rateLimit));
        rateLimit.setRecorder(address(router));

        usdc.mint(address(this), 1_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.deposit(500 * ONE);
        treasury.streamAllowance(worker, 100 * ONE, 1);
    }

    function test_allowSpendsAllowanceToTarget() public {
        (uint256 intentId, Verdict verdict) = router.propose(worker, vendor, 40 * ONE, "");
        assertEq(intentId, 0);
        assertEq(uint8(verdict), uint8(Verdict.ALLOW));
        assertEq(usdc.balanceOf(vendor), 40 * ONE);
        assertEq(treasury.allowanceBalance(worker), 60 * ONE);
    }

    function test_rateLimitEscalatesAfterRecords() public {
        router.propose(worker, vendor, 10 * ONE, "");
        router.propose(worker, vendor, 10 * ONE, "");
        // Third action in window → rate limit ESCALATE
        (uint256 intentId, Verdict verdict) = router.propose(worker, vendor, 10 * ONE, "");
        assertEq(uint8(verdict), uint8(Verdict.ESCALATE));
        assertEq(intentId, 1);
    }

    function test_resolveApprovalAlsoSpends() public {
        (uint256 intentId,) = router.propose(worker, vendor, 150 * ONE, "");
        // Over worker cap → escalate; manager can finalize (under manager cap) and spend.
        // Need enough allowance on worker for the spend on finalize.
        treasury.streamAllowance(worker, 200 * ONE, 2);

        vm.prank(manager);
        router.resolve(intentId, true);

        assertEq(usdc.balanceOf(vendor), 150 * ONE);
    }
}
