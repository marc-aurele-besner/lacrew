// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketplacePayments} from "../src/MarketplacePayments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract MarketplacePaymentsTest is Test {
    MockUSDC internal usdc;
    MarketplacePayments internal market;

    address internal governor = makeAddr("governor");
    address internal platform = makeAddr("platform");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal other = makeAddr("other");

    uint256 internal constant ONE = 1e6;
    uint16 internal constant FEE_BPS = 2000; // 20%
    bytes32 internal constant LISTING = keccak256("agent-payroll-manager");

    function setUp() public {
        usdc = new MockUSDC();
        market = new MarketplacePayments(address(usdc), platform, governor, FEE_BPS);

        usdc.mint(buyer, 10_000 * ONE);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);

        vm.prank(seller);
        market.registerListing(LISTING, 100 * ONE);
    }

    // ——— The 20% split ———

    function test_purchaseSplitsTwentyPercent() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        assertEq(market.owed(seller), 80 * ONE, "seller nets 80%");
        assertEq(market.owed(platform), 20 * ONE, "platform takes 20%");
        assertEq(market.totalOwed(), 100 * ONE);
        assertEq(usdc.balanceOf(address(market)), 100 * ONE, "gross held until withdrawal");
        assertEq(usdc.balanceOf(buyer), 9_900 * ONE);
    }

    function test_quoteMatchesPurchase() public {
        (uint256 gross, uint256 fee, uint256 net) = market.quote(LISTING);
        assertEq(gross, 100 * ONE);
        assertEq(fee, 20 * ONE);
        assertEq(net, 80 * ONE);

        vm.prank(buyer);
        market.purchase(LISTING, gross);
        assertEq(market.owed(seller), net);
        assertEq(market.owed(platform), fee);
    }

    function test_withdrawPaysOutAndClearsDebt() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        vm.prank(seller);
        uint256 got = market.withdraw();

        assertEq(got, 80 * ONE);
        assertEq(usdc.balanceOf(seller), 80 * ONE);
        assertEq(market.owed(seller), 0);
        assertEq(market.totalOwed(), 20 * ONE, "platform's share still owed");

        vm.prank(platform);
        market.withdraw();
        assertEq(usdc.balanceOf(platform), 20 * ONE);
        assertEq(market.totalOwed(), 0);
        assertEq(usdc.balanceOf(address(market)), 0, "fully settled");
    }

    /// The contract must always be able to pay what it owes.
    function test_solventForItsDebts() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);
        assertGe(usdc.balanceOf(address(market)), market.totalOwed());
        assertEq(market.unallocatedBalance(), 0);
    }

    // ——— Entitlement ———

    function test_purchaseRecordsEntitlement() public {
        assertFalse(market.hasPurchased(LISTING, buyer));
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);
        assertTrue(market.hasPurchased(LISTING, buyer));
        assertEq(market.purchasedAt(LISTING, buyer), uint64(block.timestamp));
    }

    function test_revertsOnDoublePurchase() public {
        vm.startPrank(buyer);
        market.purchase(LISTING, 100 * ONE);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.AlreadyPurchased.selector, LISTING, buyer)
        );
        market.purchase(LISTING, 100 * ONE);
        vm.stopPrank();
    }

    function test_freeListingRecordsEntitlementWithoutTransfer() public {
        bytes32 free = keccak256("free-flow");
        vm.prank(seller);
        market.registerListing(free, 0);

        vm.prank(buyer);
        market.purchase(free, 0);

        assertTrue(market.hasPurchased(free, buyer));
        assertEq(market.totalOwed(), 0);
        assertEq(usdc.balanceOf(buyer), 10_000 * ONE, "nothing moved");
    }

    // ——— Front-running guard ———

    /// A seller raising the price must not be able to collect more than the buyer agreed to.
    function test_revertsWhenPriceRaisedAboveBuyerMax() public {
        vm.prank(seller);
        market.registerListing(LISTING, 500 * ONE);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketplacePayments.PriceExceedsMax.selector, 500 * ONE, 100 * ONE
            )
        );
        market.purchase(LISTING, 100 * ONE);
    }

    function test_priceDropBelowMaxChargesTheLowerPrice() public {
        vm.prank(seller);
        market.registerListing(LISTING, 40 * ONE);

        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        assertEq(usdc.balanceOf(buyer), 9_960 * ONE, "charged the listed price, not the max");
        assertEq(market.owed(seller), 32 * ONE);
    }

    // ——— Listing ownership ———

    /// A catalog id must not be hijackable to redirect payment.
    function test_revertsWhenOtherTriesToTakeOverListing() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.NotSeller.selector, other, seller)
        );
        market.registerListing(LISTING, 1 * ONE);
    }

    function test_sellerCanUpdateOwnPrice() public {
        vm.prank(seller);
        market.registerListing(LISTING, 250 * ONE);
        (, uint256 price,) = market.listings(LISTING);
        assertEq(price, 250 * ONE);
    }

    function test_revertsWhenSellerBuysOwnListing() public {
        usdc.mint(seller, 1_000 * ONE);
        vm.startPrank(seller);
        usdc.approve(address(market), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.SellerCannotBuy.selector, LISTING)
        );
        market.purchase(LISTING, 100 * ONE);
        vm.stopPrank();
    }

    // ——— Delisting ———

    function test_delistBlocksNewPurchasesButKeepsBalances() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        vm.prank(seller);
        market.delist(LISTING);

        usdc.mint(other, 1_000 * ONE);
        vm.startPrank(other);
        usdc.approve(address(market), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.ListingInactive.selector, LISTING)
        );
        market.purchase(LISTING, 100 * ONE);
        vm.stopPrank();

        assertEq(market.owed(seller), 80 * ONE, "already-earned balance survives delisting");
        assertTrue(market.hasPurchased(LISTING, buyer), "receipt survives delisting");
    }

    function test_governorCanDelist() public {
        vm.prank(governor);
        market.delist(LISTING);
        (,, bool active) = market.listings(LISTING);
        assertFalse(active);
    }

    function test_revertsDelistByStranger() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.NotSeller.selector, other, seller)
        );
        market.delist(LISTING);
    }

    function test_revertsPurchaseOfUnknownListing() public {
        bytes32 missing = keccak256("nope");
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.ListingNotFound.selector, missing)
        );
        market.purchase(missing, 1 * ONE);
    }

    // ——— Fee governance and its ceiling ———

    function test_governorCanChangeFeeWithinCeiling() public {
        vm.prank(governor);
        market.setFeeBps(1000);

        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);
        assertEq(market.owed(platform), 10 * ONE);
        assertEq(market.owed(seller), 90 * ONE);
    }

    /// The whole point of the ceiling: governance cannot raise the take rate arbitrarily.
    function test_revertsFeeAboveCeiling() public {
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.FeeTooHigh.selector, uint16(3001), uint16(3000))
        );
        market.setFeeBps(3001);
    }

    function test_revertsConstructorFeeAboveCeiling() public {
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.FeeTooHigh.selector, uint16(5000), uint16(3000))
        );
        new MarketplacePayments(address(usdc), platform, governor, 5000);
    }

    function test_revertsFeeChangeByStranger() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(MarketplacePayments.NotGovernor.selector, other));
        market.setFeeBps(0);
    }

    /// A fee change must not retroactively alter what an earlier buyer already settled.
    function test_feeChangeDoesNotAffectSettledPurchases() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        vm.prank(governor);
        market.setFeeBps(3000);

        assertEq(market.owed(seller), 80 * ONE, "earlier split is untouched");
        assertEq(market.owed(platform), 20 * ONE);
    }

    function test_governorRotation() public {
        vm.prank(governor);
        market.setGovernor(other);
        vm.prank(other);
        market.setFeeBps(500);
        assertEq(market.feeBps(), 500);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(MarketplacePayments.NotGovernor.selector, governor));
        market.setFeeBps(100);
    }

    function test_feeRecipientChangeRoutesLaterFeesOnly() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        address newPlatform = makeAddr("newPlatform");
        vm.prank(governor);
        market.setFeeRecipient(newPlatform);

        bytes32 second = keccak256("second");
        vm.prank(seller);
        market.registerListing(second, 50 * ONE);
        vm.prank(buyer);
        market.purchase(second, 50 * ONE);

        assertEq(market.owed(platform), 20 * ONE, "old recipient keeps what it earned");
        assertEq(market.owed(newPlatform), 10 * ONE);
    }

    // ——— Withdrawal edges ———

    function test_revertsWithdrawWithNothingOwed() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(MarketplacePayments.NothingOwed.selector, other));
        market.withdraw();
    }

    function test_withdrawTwiceOnlyPaysOnce() public {
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);

        vm.startPrank(seller);
        market.withdraw();
        vm.expectRevert(abi.encodeWithSelector(MarketplacePayments.NothingOwed.selector, seller));
        market.withdraw();
        vm.stopPrank();
        assertEq(usdc.balanceOf(seller), 80 * ONE);
    }

    function test_purchaseRevertsWithoutApproval() public {
        usdc.mint(other, 1_000 * ONE);
        vm.prank(other);
        vm.expectRevert();
        market.purchase(LISTING, 100 * ONE);
    }

    // ——— Org-funded rail (purchaseFor) ———

    /// The router pays the target first, then calls it. Simulated here by transferring
    /// the price in before calling purchaseFor.
    function _deliverAndSettle(bytes32 id, address buyer, uint256 price, uint256 maxPrice)
        private
    {
        address router = market.settlementRouter();
        usdc.mint(router, price);
        vm.prank(router);
        usdc.transfer(address(market), price);
        vm.prank(router);
        market.purchaseFor(id, buyer, maxPrice);
    }

    function _wireRouter() private returns (address router) {
        router = makeAddr("router");
        vm.prank(governor);
        market.setSettlementRouter(router);
    }

    function test_purchaseForSettlesFromDeliveredFunds() public {
        _wireRouter();
        _deliverAndSettle(LISTING, buyer, 100 * ONE, 100 * ONE);

        assertTrue(market.hasPurchased(LISTING, buyer), "buyer holds the receipt, not the router");
        assertEq(market.owed(seller), 80 * ONE);
        assertEq(market.owed(platform), 20 * ONE);
        assertEq(market.unallocatedBalance(), 0, "delivery exactly consumed");
    }

    /// Without delivered funds the contract would credit debt it cannot pay.
    function test_revertsPurchaseForWithoutDeliveredFunds() public {
        address router = _wireRouter();
        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.FundsNotDelivered.selector, 100 * ONE, 0)
        );
        market.purchaseFor(LISTING, buyer, 100 * ONE);
    }

    /// A stray balance must not let a caller settle a purchase for free.
    function test_revertsPurchaseForFromStranger() public {
        _wireRouter();
        usdc.mint(address(market), 100 * ONE);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.NotSettlementRouter.selector, other)
        );
        market.purchaseFor(LISTING, buyer, 100 * ONE);
    }

    /// A seller's accrued balance must never be reachable as "delivered" funds.
    function test_purchaseForCannotConsumeAccruedSellerBalance() public {
        address router = _wireRouter();

        // Direct purchase leaves 100 owed to seller+platform, held by the contract.
        vm.prank(buyer);
        market.purchase(LISTING, 100 * ONE);
        assertEq(usdc.balanceOf(address(market)), 100 * ONE);
        assertEq(market.unallocatedBalance(), 0, "all of it is spoken for");

        bytes32 second = keccak256("second");
        vm.prank(seller);
        market.registerListing(second, 100 * ONE);

        // No new funds delivered — the held balance belongs to payees, not this purchase.
        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(MarketplacePayments.FundsNotDelivered.selector, 100 * ONE, 0)
        );
        market.purchaseFor(second, other, 100 * ONE);
    }

    function test_purchaseForRespectsMaxPrice() public {
        address router = _wireRouter();
        vm.prank(seller);
        market.registerListing(LISTING, 500 * ONE);

        usdc.mint(router, 500 * ONE);
        vm.prank(router);
        usdc.transfer(address(market), 500 * ONE);
        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketplacePayments.PriceExceedsMax.selector, 500 * ONE, 100 * ONE
            )
        );
        market.purchaseFor(LISTING, buyer, 100 * ONE);
    }

    function test_sweepRecoversOverDeliveryOnly() public {
        address router = _wireRouter();
        usdc.mint(router, 150 * ONE);
        vm.prank(router);
        usdc.transfer(address(market), 150 * ONE); // 50 more than the price
        vm.prank(router);
        market.purchaseFor(LISTING, buyer, 100 * ONE);

        assertEq(market.unallocatedBalance(), 50 * ONE);

        vm.prank(governor);
        uint256 swept = market.sweepUnallocated(platform);
        assertEq(swept, 50 * ONE);
        assertEq(usdc.balanceOf(address(market)), 100 * ONE, "payee balances untouched");
        assertEq(market.totalOwed(), 100 * ONE);

        // Payees can still be made whole after a sweep.
        vm.prank(seller);
        market.withdraw();
        assertEq(usdc.balanceOf(seller), 80 * ONE);
    }

    function test_revertsSweepByStranger() public {
        usdc.mint(address(market), 10 * ONE);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(MarketplacePayments.NotGovernor.selector, other));
        market.sweepUnallocated(other);
    }

    function test_revertsSweepWithNothingUnallocated() public {
        vm.prank(governor);
        vm.expectRevert(MarketplacePayments.NothingToSweep.selector);
        market.sweepUnallocated(platform);
    }

    // ——— Fuzz ———

    /// Fee + net must always reconstruct the gross exactly — no dust may be created or lost.
    function testFuzz_splitConservesGross(uint128 price, uint16 fee) public {
        fee = uint16(bound(fee, 0, market.MAX_FEE_BPS()));
        vm.prank(governor);
        market.setFeeBps(fee);

        bytes32 id = keccak256(abi.encode(price, fee));
        vm.prank(seller);
        market.registerListing(id, price);

        usdc.mint(buyer, price);
        vm.prank(buyer);
        market.purchase(id, price);

        assertEq(market.owed(seller) + market.owed(platform), uint256(price), "no dust");
        assertEq(market.totalOwed(), uint256(price));
        assertLe(market.owed(platform) * market.BPS_DENOMINATOR(), uint256(price) * fee + market.BPS_DENOMINATOR());
    }

    function testFuzz_everyPayeeCanAlwaysWithdraw(uint96 price) public {
        price = uint96(bound(price, 1, type(uint96).max));
        bytes32 id = keccak256(abi.encode("fuzz", price));
        vm.prank(seller);
        market.registerListing(id, price);

        usdc.mint(buyer, price);
        vm.prank(buyer);
        market.purchase(id, price);

        uint256 sellerOwed = market.owed(seller);
        uint256 platformOwed = market.owed(platform);

        if (sellerOwed > 0) {
            vm.prank(seller);
            market.withdraw();
        }
        if (platformOwed > 0) {
            vm.prank(platform);
            market.withdraw();
        }
        assertEq(market.totalOwed(), 0);
        assertEq(usdc.balanceOf(address(market)), 0, "contract retains nothing");
    }
}
