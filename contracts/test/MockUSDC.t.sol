// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_deployerCanMint() public {
        usdc.mint(address(this), 1_000e6);
        assertEq(usdc.balanceOf(address(this)), 1_000e6);
    }

    function test_strangerCannotMint() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.NotMinter.selector, stranger));
        usdc.mint(stranger, 1e6);
    }

    function test_ownerCanApproveMinter() public {
        usdc.setMinter(stranger, true);
        vm.prank(stranger);
        usdc.mint(stranger, 5e6);
        assertEq(usdc.balanceOf(stranger), 5e6);

        usdc.setMinter(stranger, false);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.NotMinter.selector, stranger));
        usdc.mint(stranger, 1e6);
    }

    function test_onlyOwnerSetsMinters() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.NotOwner.selector, stranger));
        usdc.setMinter(stranger, true);
    }

    function test_faucetDripsWithCooldown() public {
        vm.warp(1_000_000);
        vm.prank(stranger);
        usdc.faucet();
        assertEq(usdc.balanceOf(stranger), usdc.FAUCET_AMOUNT());

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockUSDC.FaucetCooldown.selector, stranger, 1_000_000 + 1 days
            )
        );
        usdc.faucet();

        vm.warp(1_000_000 + 1 days);
        vm.prank(stranger);
        usdc.faucet();
        assertEq(usdc.balanceOf(stranger), 2 * usdc.FAUCET_AMOUNT());
    }
}
