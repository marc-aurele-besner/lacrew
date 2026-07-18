// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @dev Handler driving EscalationRouter propose/resolve against a wired Treasury.
///      Ghost accounting tracks every successfully executed action value.
contract RouterHandler is Test {
    uint256 internal constant ONE = 1e6;
    uint256 internal constant MAX_PROPOSE = 600 * ONE;

    EscalationRouter public immutable router;
    Treasury public immutable treasury;
    MockUSDC public immutable usdc;
    OrgRegistry public immutable registry;

    address public immutable root;
    address public immutable manager;
    address public immutable worker;
    address public immutable goodTarget;
    address public immutable badTarget;
    address internal stranger = makeAddr("stranger");

    uint256[] public intentIds;
    /// @notice Sum of values for every action the router actually executed.
    uint256 public ghostExecutedValue;

    constructor(
        EscalationRouter router_,
        Treasury treasury_,
        MockUSDC usdc_,
        OrgRegistry registry_,
        address root_,
        address manager_,
        address worker_,
        address goodTarget_,
        address badTarget_
    ) {
        router = router_;
        treasury = treasury_;
        usdc = usdc_;
        registry = registry_;
        root = root_;
        manager = manager_;
        worker = worker_;
        goodTarget = goodTarget_;
        badTarget = badTarget_;
    }

    function intentCount() external view returns (uint256) {
        return intentIds.length;
    }

    /// @notice Propose as worker or manager against the good or bad target.
    function propose(uint256 agentSeed, bool useBadTarget, uint256 value) external {
        address agent = agentSeed % 2 == 0 ? worker : manager;
        address target = useBadTarget ? badTarget : goodTarget;
        value = bound(value, 1, MAX_PROPOSE);

        try router.propose(agent, target, value, "") returns (uint256 intentId, Verdict verdict) {
            if (useBadTarget) {
                assertTrue(false, "non-whitelisted target must never pass propose");
            }
            if (intentId == 0) {
                assertEq(uint8(verdict), uint8(Verdict.ALLOW), "id 0 implies ALLOW");
                ghostExecutedValue += value;
            } else {
                intentIds.push(intentId);
            }
        } catch {}
    }

    /// @notice Resolve a tracked intent as its current approver; re-resolve must revert.
    function resolve(uint256 idSeed, bool approve) external {
        if (intentIds.length == 0) return;
        uint256 intentId = intentIds[idSeed % intentIds.length];
        (, , uint256 value, , address awaiting, bool resolved,) = router.intents(intentId);

        if (resolved) {
            vm.prank(awaiting);
            try router.resolve(intentId, approve) {
                assertTrue(false, "resolved intent must not resolve again");
            } catch {}
            return;
        }

        vm.prank(awaiting);
        try router.resolve(intentId, approve) {
            (, , , , , bool nowResolved, bool nowApproved) = router.intents(intentId);
            if (nowResolved && nowApproved) {
                ghostExecutedValue += value;
            }
        } catch {}
    }

    /// @notice A stranger must never resolve any intent.
    function strangerResolve(uint256 idSeed, bool approve) external {
        if (intentIds.length == 0) return;
        uint256 intentId = intentIds[idSeed % intentIds.length];
        (, , , , , bool resolved,) = router.intents(intentId);
        if (resolved) return;

        vm.prank(stranger);
        try router.resolve(intentId, approve) {
            assertTrue(false, "stranger must never resolve an intent");
        } catch {}
    }

    /// @notice Stream more treasury allowance to worker or manager.
    function stream(uint256 nodeSeed, uint256 amount) external {
        uint256 liquid = treasury.liquidBalance();
        if (liquid == 0) return;
        address node = nodeSeed % 2 == 0 ? worker : manager;
        amount = bound(amount, 1, liquid);
        treasury.streamAllowance(node, amount, 1);
    }
}

/// @dev Invariants over the full propose → escalate → resolve → spend path.
contract RouterInvariantTest is StdInvariant, Test {
    uint256 internal constant ONE = 1e6;
    uint256 internal constant TOTAL_DEPOSIT = 100_000 * ONE;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal goodTarget = makeAddr("goodTarget");
    address internal badTarget = makeAddr("badTarget");

    OrgRegistry internal registry;
    MockUSDC internal usdc;
    Treasury internal treasury;
    EscalationRouter internal router;
    RouterHandler internal handler;

    function setUp() public {
        registry = new OrgRegistry(root);
        vm.prank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        vm.prank(root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(goodTarget, true);

        SpendCapPolicy spendCap = new SpendCapPolicy(100 * ONE);
        spendCap.setAgentCap(manager, 300 * ONE);
        spendCap.setAgentCap(root, type(uint256).max);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        usdc = new MockUSDC();
        treasury = new Treasury(address(registry), address(usdc), address(router));
        router.setTreasury(address(treasury));

        usdc.mint(address(this), TOTAL_DEPOSIT);
        usdc.approve(address(treasury), TOTAL_DEPOSIT);
        treasury.deposit(TOTAL_DEPOSIT);
        treasury.streamAllowance(worker, 10_000 * ONE, 1);

        handler = new RouterHandler(
            router, treasury, usdc, registry, root, manager, worker, goodTarget, badTarget
        );
        targetContract(address(handler));
    }

    /// @notice First-DENY-wins: funds never reach a non-whitelisted target.
    function invariant_badTargetNeverPaid() public view {
        assertEq(usdc.balanceOf(badTarget), 0);
    }

    /// @notice Conservation: every token is in the treasury or at the executed target.
    function invariant_tokenConservation() public view {
        assertEq(
            usdc.balanceOf(address(treasury)) + usdc.balanceOf(goodTarget),
            TOTAL_DEPOSIT
        );
    }

    /// @notice Target only receives what the router actually executed.
    function invariant_targetMatchesExecutedGhost() public view {
        assertEq(usdc.balanceOf(goodTarget), handler.ghostExecutedValue());
    }

    /// @notice Reserved working capital never exceeds tokens held.
    function invariant_reservedCovered() public view {
        assertGe(usdc.balanceOf(address(treasury)), treasury.totalReserved());
    }

    /// @notice Per-node allowances stay consistent with total reserved.
    function invariant_allowancesMatchReserved() public view {
        assertEq(
            treasury.allowanceBalance(worker) + treasury.allowanceBalance(manager),
            treasury.totalReserved()
        );
    }

    /// @notice Pending intents always await an ancestor of the proposing agent.
    function invariant_pendingApproverIsAncestor() public view {
        uint256 n = handler.intentCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 intentId = handler.intentIds(i);
            (address agent, , , , address awaiting, bool resolved,) = router.intents(intentId);
            if (resolved) continue;

            bool found = false;
            address cursor = registry.getNode(agent).parent;
            while (cursor != address(0)) {
                if (cursor == awaiting) {
                    found = true;
                    break;
                }
                cursor = registry.getNode(cursor).parent;
            }
            assertTrue(found, "pending approver must be an ancestor of the agent");
        }
    }
}
