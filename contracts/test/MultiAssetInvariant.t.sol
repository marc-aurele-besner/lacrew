// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// @dev Drives propose/resolve/stream across TWO asset stacks that share one
///      OrgRegistry. Isolation is the property under test: no random interleaving
///      may move one asset's token into the other asset's treasury or target.
contract MultiAssetHandler is Test {
    OrgRegistry public immutable registry;
    address public immutable manager;
    address public immutable worker;
    address public immutable badTarget;

    // The 6-decimal (USDC) stack.
    MockUSDC public immutable usdc;
    Treasury public immutable usdcTreasury;
    EscalationRouter public immutable usdcRouter;
    address public immutable usdcTarget;
    uint256 internal constant USDC_MAX = 600e6;
    uint256[] public usdcIntents;
    uint256 public usdcExecuted;

    // The 18-decimal (WETH) stack.
    MockWETH public immutable weth;
    Treasury public immutable wethTreasury;
    EscalationRouter public immutable wethRouter;
    address public immutable wethTarget;
    uint256 internal constant WETH_MAX = 6e18;
    uint256[] public wethIntents;
    uint256 public wethExecuted;

    constructor(
        OrgRegistry registry_,
        address manager_,
        address worker_,
        address badTarget_,
        MockUSDC usdc_,
        Treasury usdcTreasury_,
        EscalationRouter usdcRouter_,
        address usdcTarget_,
        MockWETH weth_,
        Treasury wethTreasury_,
        EscalationRouter wethRouter_,
        address wethTarget_
    ) {
        registry = registry_;
        manager = manager_;
        worker = worker_;
        badTarget = badTarget_;
        usdc = usdc_;
        usdcTreasury = usdcTreasury_;
        usdcRouter = usdcRouter_;
        usdcTarget = usdcTarget_;
        weth = weth_;
        wethTreasury = wethTreasury_;
        wethRouter = wethRouter_;
        wethTarget = wethTarget_;
    }

    function usdcIntentCount() external view returns (uint256) {
        return usdcIntents.length;
    }

    function wethIntentCount() external view returns (uint256) {
        return wethIntents.length;
    }

    // ── USDC (6-decimal) stack ───────────────────────────────────────────────

    function proposeUsdc(uint256 agentSeed, bool useBadTarget, uint256 value) external {
        address agent = agentSeed % 2 == 0 ? worker : manager;
        address target = useBadTarget ? badTarget : usdcTarget;
        value = bound(value, 1, USDC_MAX);
        try usdcRouter.propose(agent, target, value, "") returns (uint256 intentId, Verdict verdict) {
            if (useBadTarget) assertTrue(false, "non-whitelisted target must never pass propose");
            if (intentId == 0) {
                assertEq(uint8(verdict), uint8(Verdict.ALLOW), "id 0 implies ALLOW");
                usdcExecuted += value;
            } else {
                usdcIntents.push(intentId);
            }
        } catch {}
    }

    function resolveUsdc(uint256 idSeed, bool approve) external {
        if (usdcIntents.length == 0) return;
        uint256 intentId = usdcIntents[idSeed % usdcIntents.length];
        (,, uint256 value,, address awaiting, bool resolved,) = usdcRouter.intents(intentId);
        if (resolved) return;
        vm.prank(awaiting);
        try usdcRouter.resolve(intentId, approve) {
            (,,,,, bool nowResolved, bool nowApproved) = usdcRouter.intents(intentId);
            if (nowResolved && nowApproved) usdcExecuted += value;
        } catch {}
    }

    function streamUsdc(uint256 nodeSeed, uint256 amount) external {
        uint256 liquid = usdcTreasury.liquidBalance();
        if (liquid == 0) return;
        address node = nodeSeed % 2 == 0 ? worker : manager;
        usdcTreasury.streamAllowance(node, bound(amount, 1, liquid), 1);
    }

    // ── WETH (18-decimal) stack ──────────────────────────────────────────────

    function proposeWeth(uint256 agentSeed, bool useBadTarget, uint256 value) external {
        address agent = agentSeed % 2 == 0 ? worker : manager;
        address target = useBadTarget ? badTarget : wethTarget;
        value = bound(value, 1, WETH_MAX);
        try wethRouter.propose(agent, target, value, "") returns (uint256 intentId, Verdict verdict) {
            if (useBadTarget) assertTrue(false, "non-whitelisted target must never pass propose");
            if (intentId == 0) {
                assertEq(uint8(verdict), uint8(Verdict.ALLOW), "id 0 implies ALLOW");
                wethExecuted += value;
            } else {
                wethIntents.push(intentId);
            }
        } catch {}
    }

    function resolveWeth(uint256 idSeed, bool approve) external {
        if (wethIntents.length == 0) return;
        uint256 intentId = wethIntents[idSeed % wethIntents.length];
        (,, uint256 value,, address awaiting, bool resolved,) = wethRouter.intents(intentId);
        if (resolved) return;
        vm.prank(awaiting);
        try wethRouter.resolve(intentId, approve) {
            (,,,,, bool nowResolved, bool nowApproved) = wethRouter.intents(intentId);
            if (nowResolved && nowApproved) wethExecuted += value;
        } catch {}
    }

    function streamWeth(uint256 nodeSeed, uint256 amount) external {
        uint256 liquid = wethTreasury.liquidBalance();
        if (liquid == 0) return;
        address node = nodeSeed % 2 == 0 ? worker : manager;
        wethTreasury.streamAllowance(node, bound(amount, 1, liquid), 1);
    }
}

/// @notice Multi-asset isolation invariants (PRD F0.4 / F1.1).
/// @dev Two Treasury+Router stacks (6- and 18-decimal) over ONE OrgRegistry.
///      Proves that sharing the org chart across assets never lets funds cross
///      between them, under any fuzzed interleaving of proposes/resolves.
contract MultiAssetInvariantTest is StdInvariant, Test {
    uint256 internal constant USDC_DEPOSIT = 100_000e6;
    uint256 internal constant WETH_DEPOSIT = 1_000e18;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal usdcTarget = makeAddr("usdcTarget");
    address internal wethTarget = makeAddr("wethTarget");
    address internal badTarget = makeAddr("badTarget");

    OrgRegistry internal registry;
    MockUSDC internal usdc;
    Treasury internal usdcTreasury;
    EscalationRouter internal usdcRouter;
    MockWETH internal weth;
    Treasury internal wethTreasury;
    EscalationRouter internal wethRouter;
    MultiAssetHandler internal handler;

    function setUp() public {
        // One org tree, shared by both asset stacks.
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        usdc = new MockUSDC();
        (usdcTreasury, usdcRouter) = _deployStack(address(usdc), usdcTarget, 100e6, 300e6);
        usdc.mint(address(this), USDC_DEPOSIT);
        usdc.approve(address(usdcTreasury), USDC_DEPOSIT);
        usdcTreasury.deposit(USDC_DEPOSIT);
        usdcTreasury.streamAllowance(worker, 10_000e6, 1);

        weth = new MockWETH();
        (wethTreasury, wethRouter) = _deployStack(address(weth), wethTarget, 2e18, 6e18);
        weth.mint(address(this), WETH_DEPOSIT);
        weth.approve(address(wethTreasury), WETH_DEPOSIT);
        wethTreasury.deposit(WETH_DEPOSIT);
        wethTreasury.streamAllowance(worker, 100e18, 1);

        handler = new MultiAssetHandler(
            registry,
            manager,
            worker,
            badTarget,
            usdc,
            usdcTreasury,
            usdcRouter,
            usdcTarget,
            weth,
            wethTreasury,
            wethRouter,
            wethTarget
        );
        targetContract(address(handler));
    }

    /// Deploy one asset stack (whitelist its own target; asset-denominated caps).
    function _deployStack(address token, address target, uint256 workerCap, uint256 managerCap)
        internal
        returns (Treasury treasury, EscalationRouter router)
    {
        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(target, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(workerCap);
        spendCap.setAgentCap(manager, managerCap);
        spendCap.setAgentCap(root, type(uint256).max);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        treasury = new Treasury(address(registry), token, address(router));
        router.setTreasury(address(treasury));
    }

    /// @notice Every USDC token sits in its treasury or at its target — never elsewhere.
    function invariant_usdcConserved() public view {
        assertEq(usdc.balanceOf(address(usdcTreasury)) + usdc.balanceOf(usdcTarget), USDC_DEPOSIT);
    }

    /// @notice Every WETH token sits in its treasury or at its target — never elsewhere.
    function invariant_wethConserved() public view {
        assertEq(weth.balanceOf(address(wethTreasury)) + weth.balanceOf(wethTarget), WETH_DEPOSIT);
    }

    /// @notice The core isolation property: neither token ever lands in the other
    ///         asset's treasury or target, however the two routers interleave.
    function invariant_noCrossAssetLeak() public view {
        assertEq(weth.balanceOf(address(usdcTreasury)), 0, "USDC treasury holds no WETH");
        assertEq(weth.balanceOf(usdcTarget), 0, "USDC target holds no WETH");
        assertEq(usdc.balanceOf(address(wethTreasury)), 0, "WETH treasury holds no USDC");
        assertEq(usdc.balanceOf(wethTarget), 0, "WETH target holds no USDC");
    }

    /// @notice A non-whitelisted target is never paid in either asset.
    function invariant_badTargetNeverPaid() public view {
        assertEq(usdc.balanceOf(badTarget), 0);
        assertEq(weth.balanceOf(badTarget), 0);
    }

    /// @notice Each target holds exactly what its router settled (per-asset ghost).
    function invariant_targetsMatchExecuted() public view {
        assertEq(usdc.balanceOf(usdcTarget), handler.usdcExecuted());
        assertEq(weth.balanceOf(wethTarget), handler.wethExecuted());
    }

    /// @notice Each treasury always holds at least its reserved working capital.
    function invariant_reservedCovered() public view {
        assertGe(usdc.balanceOf(address(usdcTreasury)), usdcTreasury.totalReserved());
        assertGe(weth.balanceOf(address(wethTreasury)), wethTreasury.totalReserved());
    }

    /// @notice Per-asset: node allowances sum to that treasury's totalReserved.
    function invariant_allowancesMatchReserved() public view {
        assertEq(
            usdcTreasury.allowanceBalance(worker) + usdcTreasury.allowanceBalance(manager),
            usdcTreasury.totalReserved()
        );
        assertEq(
            wethTreasury.allowanceBalance(worker) + wethTreasury.allowanceBalance(manager),
            wethTreasury.totalReserved()
        );
    }
}
