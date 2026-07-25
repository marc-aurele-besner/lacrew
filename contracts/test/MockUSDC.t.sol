// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
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

    // ---------------------------------------------------------------- EIP-3009

    uint256 internal payerKey;
    address internal payer;
    address internal payee = makeAddr("payee");
    address internal relayer = makeAddr("relayer");

    function _fundPayer(uint256 amount) internal {
        (payer, payerKey) = makeAddrAndKey("payer");
        usdc.mint(payer, amount);
    }

    function _signTransferAuthorization(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce
                )
            )
        );
        return vm.sign(key, digest);
    }

    function test_transferWithAuthorizationMovesFundsFromAnyRelayer() public {
        vm.warp(1_000_000);
        _fundPayer(50e6);
        bytes32 nonce = keccak256("payment-1");
        (uint8 v, bytes32 r, bytes32 s) =
            _signTransferAuthorization(payerKey, payer, payee, 15e6, 0, block.timestamp + 600, nonce);

        assertFalse(usdc.authorizationState(payer, nonce));
        vm.prank(relayer);
        usdc.transferWithAuthorization(payer, payee, 15e6, 0, block.timestamp + 600, nonce, v, r, s);

        assertEq(usdc.balanceOf(payee), 15e6);
        assertEq(usdc.balanceOf(payer), 35e6);
        assertTrue(usdc.authorizationState(payer, nonce));
    }

    function test_replayIsRejectedWithoutDoublePaying() public {
        vm.warp(1_000_000);
        _fundPayer(50e6);
        bytes32 nonce = keccak256("payment-replay");
        (uint8 v, bytes32 r, bytes32 s) =
            _signTransferAuthorization(payerKey, payer, payee, 10e6, 0, block.timestamp + 600, nonce);

        usdc.transferWithAuthorization(payer, payee, 10e6, 0, block.timestamp + 600, nonce, v, r, s);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationUsedOrCanceled.selector, payer, nonce));
        usdc.transferWithAuthorization(payer, payee, 10e6, 0, block.timestamp + 600, nonce, v, r, s);
        assertEq(usdc.balanceOf(payee), 10e6);
    }

    function test_tamperedAmountIsRejected() public {
        vm.warp(1_000_000);
        _fundPayer(50e6);
        bytes32 nonce = keccak256("payment-tampered");
        (uint8 v, bytes32 r, bytes32 s) =
            _signTransferAuthorization(payerKey, payer, payee, 5e6, 0, block.timestamp + 600, nonce);

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InvalidAuthorizationSignature.selector, payer));
        usdc.transferWithAuthorization(payer, payee, 6e6, 0, block.timestamp + 600, nonce, v, r, s);
    }

    function test_timingWindowIsEnforced() public {
        vm.warp(1_000_000);
        _fundPayer(50e6);
        bytes32 nonce = keccak256("payment-timing");
        // Literals, not `block.timestamp + n`: under via-IR the optimizer may
        // rematerialize the expression after a warp, re-reading the new time.
        uint256 validAfter = 1_000_100;
        uint256 validBefore = 1_000_200;
        (uint8 v, bytes32 r, bytes32 s) =
            _signTransferAuthorization(payerKey, payer, payee, 5e6, validAfter, validBefore, nonce);

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationNotYetValid.selector, validAfter));
        usdc.transferWithAuthorization(payer, payee, 5e6, validAfter, validBefore, nonce, v, r, s);

        vm.warp(validBefore);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationExpired.selector, validBefore));
        usdc.transferWithAuthorization(payer, payee, 5e6, validAfter, validBefore, nonce, v, r, s);

        vm.warp(validAfter + 1);
        usdc.transferWithAuthorization(payer, payee, 5e6, validAfter, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(payee), 5e6);
    }

    function test_bytesOverloadAcceptsErc1271ContractPayer() public {
        vm.warp(1_000_000);
        Erc1271Wallet wallet = new Erc1271Wallet();
        usdc.mint(address(wallet), 20e6);
        bytes32 nonce = keccak256("payment-1271");

        vm.prank(relayer);
        usdc.transferWithAuthorization(
            address(wallet), payee, 8e6, 0, block.timestamp + 600, nonce, bytes("wallet-approved")
        );
        assertEq(usdc.balanceOf(payee), 8e6);

        wallet.setApproved(false);
        bytes32 nonce2 = keccak256("payment-1271-refused");
        vm.expectRevert(
            abi.encodeWithSelector(MockUSDC.InvalidAuthorizationSignature.selector, address(wallet))
        );
        usdc.transferWithAuthorization(
            address(wallet), payee, 8e6, 0, block.timestamp + 600, nonce2, bytes("wallet-approved")
        );
    }

    function test_cancelAuthorizationBurnsNonce() public {
        vm.warp(1_000_000);
        _fundPayer(50e6);
        bytes32 nonce = keccak256("payment-canceled");
        (uint8 v, bytes32 r, bytes32 s) =
            _signTransferAuthorization(payerKey, payer, payee, 5e6, 0, block.timestamp + 600, nonce);

        bytes32 cancelDigest = MessageHashUtils.toTypedDataHash(
            usdc.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce))
        );
        (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(payerKey, cancelDigest);
        usdc.cancelAuthorization(payer, nonce, abi.encodePacked(cr, cs, cv));
        assertTrue(usdc.authorizationState(payer, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationUsedOrCanceled.selector, payer, nonce));
        usdc.transferWithAuthorization(payer, payee, 5e6, 0, block.timestamp + 600, nonce, v, r, s);
        assertEq(usdc.balanceOf(payee), 0);
    }
}

/// @dev Minimal ERC-1271 wallet: approves any digest while toggled on.
contract Erc1271Wallet {
    bool internal approved = true;

    function setApproved(bool value) external {
        approved = value;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        return approved ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
