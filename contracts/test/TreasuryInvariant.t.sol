// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @dev Handler for Foundry invariant runs against Treasury accounting.
contract TreasuryHandler is Test {
    Treasury public immutable treasury;
    MockUSDC public immutable usdc;
    address public immutable router;
    address[] public nodes;

    uint256 public ghostStreamed;
    uint256 public ghostSpent;

    constructor(Treasury treasury_, MockUSDC usdc_, address router_) {
        treasury = treasury_;
        usdc = usdc_;
        router = router_;
        nodes.push(makeAddr("workerA"));
        nodes.push(makeAddr("workerB"));
        nodes.push(makeAddr("workerC"));
    }

    function stream(uint256 nodeSeed, uint256 amount) external {
        address node = nodes[nodeSeed % nodes.length];
        uint256 liquid = treasury.liquidBalance();
        if (liquid == 0) return;
        amount = bound(amount, 1, liquid);
        treasury.streamAllowance(node, amount, 1);
        ghostStreamed += amount;
    }

    function spend(uint256 nodeSeed, uint256 amount) external {
        address node = nodes[nodeSeed % nodes.length];
        uint256 available = treasury.allowanceBalance(node);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(router);
        treasury.spendAllowance(node, amount, address(this));
        ghostSpent += amount;
    }

    function depositMore(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(treasury), amount);
        treasury.deposit(amount);
    }
}

contract TreasuryInvariantTest is StdInvariant, Test {
    uint256 internal constant ONE = 1e6;

    MockUSDC internal usdc;
    Treasury internal treasury;
    TreasuryHandler internal handler;
    address internal router = makeAddr("router");

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new Treasury(makeAddr("registry"), address(usdc), router);
        handler = new TreasuryHandler(treasury, usdc, router);

        usdc.mint(address(handler), 1_000_000 * ONE);
        vm.prank(address(handler));
        usdc.approve(address(treasury), type(uint256).max);
        vm.prank(address(handler));
        treasury.deposit(100_000 * ONE);

        targetContract(address(handler));
    }

    /// @notice Reserved working capital never exceeds tokens held.
    function invariant_balanceCoversReserved() public view {
        assertGe(usdc.balanceOf(address(treasury)), treasury.totalReserved());
    }

    /// @notice liquid + reserved accounting identity.
    function invariant_liquidPlusReservedEqualsBalance() public view {
        uint256 bal = usdc.balanceOf(address(treasury));
        assertEq(treasury.liquidBalance() + treasury.totalReserved(), bal);
    }

    /// @notice Sum of tracked node allowances equals totalReserved.
    function invariant_sumAllowancesEqualsReserved() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += treasury.allowanceBalance(handler.nodes(i));
        }
        assertEq(sum, treasury.totalReserved());
    }
}
