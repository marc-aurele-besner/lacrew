// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract TreasuryTest is Test {
    MockUSDC internal usdc;
    Treasury internal treasury;
    address internal registry = makeAddr("registry");
    address internal router = makeAddr("router");
    address internal worker = makeAddr("worker");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant ONE = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new Treasury(registry, address(usdc), router);
        usdc.mint(address(this), 1_000_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
    }

    function test_depositAndStream() public {
        treasury.deposit(1000 * ONE);
        assertEq(treasury.liquidBalance(), 1000 * ONE);

        treasury.streamAllowance(worker, 100 * ONE, 1);
        assertEq(treasury.allowanceBalance(worker), 100 * ONE);
        assertEq(treasury.liquidBalance(), 900 * ONE);
        assertEq(treasury.totalReserved(), 100 * ONE);
    }

    function test_spendByRouter() public {
        treasury.deposit(500 * ONE);
        treasury.streamAllowance(worker, 50 * ONE, 1);

        vm.prank(router);
        treasury.spendAllowance(worker, 20 * ONE, recipient);

        assertEq(usdc.balanceOf(recipient), 20 * ONE);
        assertEq(treasury.allowanceBalance(worker), 30 * ONE);
        assertEq(treasury.totalReserved(), 30 * ONE);
    }

    function test_spendToRouterOverload() public {
        treasury.deposit(100 * ONE);
        treasury.streamAllowance(worker, 40 * ONE, 1);

        vm.prank(router);
        treasury.spendAllowance(worker, 10 * ONE);

        assertEq(usdc.balanceOf(router), 10 * ONE);
    }

    function test_revertsInsufficientTreasury() public {
        treasury.deposit(10 * ONE);
        vm.expectRevert(
            abi.encodeWithSelector(Treasury.InsufficientTreasury.selector, 20 * ONE, 10 * ONE)
        );
        treasury.streamAllowance(worker, 20 * ONE, 1);
    }

    function test_revertsInsufficientAllowance() public {
        treasury.deposit(100 * ONE);
        treasury.streamAllowance(worker, 10 * ONE, 1);
        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(Treasury.InsufficientAllowance.selector, worker, 11 * ONE, 10 * ONE)
        );
        treasury.spendAllowance(worker, 11 * ONE, recipient);
    }

    function test_revertsNotSpender() public {
        treasury.deposit(100 * ONE);
        treasury.streamAllowance(worker, 10 * ONE, 1);
        vm.expectRevert(abi.encodeWithSelector(Treasury.NotSpender.selector, address(this)));
        treasury.spendAllowance(worker, 1 * ONE, recipient);
    }
}
