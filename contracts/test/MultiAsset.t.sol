// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {EpochStreamer} from "../src/EpochStreamer.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";

/// 18-decimal asset so the suite covers a decimals profile MockUSDC cannot.
contract MockWETH is ERC20 {
    constructor() ERC20("Mock WETH", "mWETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Multi-asset treasuries (PRD F0.4).
/// @dev A Treasury binds one immutable ERC-20, so an org funds N assets by
///      deploying one Treasury + EscalationRouter + EpochStreamer per asset
///      over a shared OrgRegistry. These tests prove the assets stay isolated
///      and that policy stacks must be denominated per asset.
contract MultiAssetTest is Test {
    uint256 internal constant USDC_ONE = 1e6;
    uint256 internal constant WETH_ONE = 1e18;

    address internal root = makeAddr("root");
    address internal manager = makeAddr("manager");
    address internal worker = makeAddr("worker");
    address internal vendor = makeAddr("vendor");

    OrgRegistry internal registry;

    MockUSDC internal usdc;
    Treasury internal usdcTreasury;
    EscalationRouter internal usdcRouter;
    EpochStreamer internal usdcStreamer;

    MockWETH internal weth;
    Treasury internal wethTreasury;
    EscalationRouter internal wethRouter;
    EpochStreamer internal wethStreamer;

    function setUp() public {
        // One org tree, shared by every asset stack.
        registry = new OrgRegistry(root);
        vm.startPrank(root);
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, root);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        vm.stopPrank();

        usdc = new MockUSDC();
        (usdcTreasury, usdcRouter, usdcStreamer) = _deployAssetStack(address(usdc), 50 * USDC_ONE);
        usdc.mint(address(this), 10_000 * USDC_ONE);
        usdc.approve(address(usdcTreasury), type(uint256).max);
        usdcTreasury.deposit(1_000 * USDC_ONE);

        weth = new MockWETH();
        (wethTreasury, wethRouter, wethStreamer) = _deployAssetStack(address(weth), 2 * WETH_ONE);
        weth.mint(address(this), 100 * WETH_ONE);
        weth.approve(address(wethTreasury), type(uint256).max);
        wethTreasury.deposit(10 * WETH_ONE);
    }

    /// Deploy one asset's enforcement stack with an asset-denominated cap.
    function _deployAssetStack(address token, uint256 workerCap)
        internal
        returns (Treasury treasury, EscalationRouter router, EpochStreamer streamer)
    {
        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(vendor, true);
        SpendCapPolicy spendCap = new SpendCapPolicy(workerCap);
        spendCap.setAgentCap(manager, workerCap * 10);
        spendCap.setAgentCap(root, type(uint256).max);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        router = new EscalationRouter(address(registry), address(stack));
        treasury = new Treasury(address(registry), token, address(router));
        router.setTreasury(address(treasury));

        streamer = new EpochStreamer(address(treasury), address(this));
        treasury.setStreamer(address(streamer));
    }

    function test_assetsStreamAndSpendIndependently() public {
        usdcStreamer.setGrant(worker, 100 * USDC_ONE);
        wethStreamer.setGrant(worker, 1 * WETH_ONE);
        usdcStreamer.runNextEpoch();
        wethStreamer.runNextEpoch();

        assertEq(usdcTreasury.allowanceBalance(worker), 100 * USDC_ONE);
        assertEq(wethTreasury.allowanceBalance(worker), 1 * WETH_ONE);

        // Spend USDC only — the WETH allowance is untouched.
        (, Verdict usdcVerdict) = usdcRouter.propose(worker, vendor, 40 * USDC_ONE, "");
        assertEq(uint8(usdcVerdict), uint8(Verdict.ALLOW));
        assertEq(usdc.balanceOf(vendor), 40 * USDC_ONE);
        assertEq(weth.balanceOf(vendor), 0);
        assertEq(usdcTreasury.allowanceBalance(worker), 60 * USDC_ONE);
        assertEq(wethTreasury.allowanceBalance(worker), 1 * WETH_ONE);

        // Spend WETH — USDC bookkeeping stays where it was.
        (, Verdict wethVerdict) = wethRouter.propose(worker, vendor, 5e17, "");
        assertEq(uint8(wethVerdict), uint8(Verdict.ALLOW));
        assertEq(weth.balanceOf(vendor), 5e17);
        assertEq(usdcTreasury.allowanceBalance(worker), 60 * USDC_ONE);
        assertEq(wethTreasury.allowanceBalance(worker), 5e17);
    }

    /// Caps are asset-denominated: the same nominal spend escalates in one
    /// asset and passes in the other, so stacks must never be shared across
    /// assets with different decimals.
    function test_capsAreAssetDenominated() public {
        usdcStreamer.setGrant(worker, 1_000 * USDC_ONE);
        wethStreamer.setGrant(worker, 5 * WETH_ONE);
        usdcStreamer.runNextEpoch();
        wethStreamer.runNextEpoch();

        // 75 USDC > 50 USDC worker cap → escalate.
        (, Verdict overCap) = usdcRouter.propose(worker, vendor, 75 * USDC_ONE, "");
        assertEq(uint8(overCap), uint8(Verdict.ESCALATE));

        // The identical raw amount is dust in 18 decimals → well under the WETH cap.
        (, Verdict underCap) = wethRouter.propose(worker, vendor, 75 * USDC_ONE, "");
        assertEq(uint8(underCap), uint8(Verdict.ALLOW));
    }

    /// An asset's treasury only ever moves its own token.
    function test_treasuryCannotSpendForeignAsset() public {
        usdcStreamer.setGrant(worker, 100 * USDC_ONE);
        usdcStreamer.runNextEpoch();

        uint256 wethTreasuryBefore = weth.balanceOf(address(wethTreasury));
        usdcRouter.propose(worker, vendor, 10 * USDC_ONE, "");

        assertEq(weth.balanceOf(address(wethTreasury)), wethTreasuryBefore);
        assertEq(weth.balanceOf(vendor), 0);
        assertEq(usdc.balanceOf(vendor), 10 * USDC_ONE);
    }

    /// Escalation climbs independently per asset: approving in one asset's
    /// router never finalizes a pending intent in another's.
    function test_escalationsAreScopedPerAsset() public {
        usdcStreamer.setGrant(worker, 500 * USDC_ONE);
        wethStreamer.setGrant(worker, 5 * WETH_ONE);
        usdcStreamer.runNextEpoch();
        wethStreamer.runNextEpoch();

        (uint256 usdcIntent, Verdict v1) = usdcRouter.propose(worker, vendor, 75 * USDC_ONE, "");
        (uint256 wethIntent, Verdict v2) = wethRouter.propose(worker, vendor, 3 * WETH_ONE, "");
        assertEq(uint8(v1), uint8(Verdict.ESCALATE));
        assertEq(uint8(v2), uint8(Verdict.ESCALATE));

        // Manager approves the USDC intent only.
        vm.prank(manager);
        usdcRouter.resolve(usdcIntent, true);

        assertEq(usdc.balanceOf(vendor), 75 * USDC_ONE);
        assertEq(weth.balanceOf(vendor), 0);

        // The WETH intent is still pending in its own router.
        vm.prank(manager);
        wethRouter.resolve(wethIntent, true);
        assertEq(weth.balanceOf(vendor), 3 * WETH_ONE);
    }
}
