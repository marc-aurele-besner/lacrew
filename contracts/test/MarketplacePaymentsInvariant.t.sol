// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MarketplacePayments} from "../src/MarketplacePayments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @dev Handler driving arbitrary list / purchase / withdraw / fee-change sequences.
contract MarketplaceHandler is Test {
    MarketplacePayments public immutable market;
    MockUSDC public immutable usdc;
    address public immutable governor;
    address public immutable platform;

    address[] public sellers;
    address[] public buyers;
    bytes32[] public listingIds;

    /// @dev Every unit a buyer has paid in, and every unit paid out. The contract's
    ///      balance must be exactly the difference at all times.
    uint256 public ghostPaidIn;
    uint256 public ghostPaidOut;

    constructor(MarketplacePayments market_, MockUSDC usdc_, address governor_, address platform_) {
        market = market_;
        usdc = usdc_;
        governor = governor_;
        platform = platform_;

        sellers.push(makeAddr("sellerA"));
        sellers.push(makeAddr("sellerB"));
        buyers.push(makeAddr("buyerA"));
        buyers.push(makeAddr("buyerB"));
        buyers.push(makeAddr("buyerC"));

        for (uint256 i = 0; i < 4; i++) {
            listingIds.push(keccak256(abi.encode("listing", i)));
        }
    }

    function buyerCount() external view returns (uint256) {
        return buyers.length;
    }

    function list(uint256 sellerSeed, uint256 idSeed, uint256 price) external {
        address seller = sellers[sellerSeed % sellers.length];
        bytes32 id = listingIds[idSeed % listingIds.length];
        (address owner,,) = market.listings(id);
        if (owner != address(0) && owner != seller) return;
        price = bound(price, 0, 10_000e6);
        vm.prank(seller);
        market.registerListing(id, price);
    }

    function buy(uint256 buyerSeed, uint256 idSeed) external {
        address buyer = buyers[buyerSeed % buyers.length];
        bytes32 id = listingIds[idSeed % listingIds.length];
        (address seller, uint256 price, bool active) = market.listings(id);
        if (seller == address(0) || !active || seller == buyer) return;
        if (market.hasPurchased(id, buyer)) return;
        if (usdc.balanceOf(buyer) < price) return;

        vm.prank(buyer);
        market.purchase(id, price);
        ghostPaidIn += price;
    }

    /// The org-funded rail: funds are pushed in, then settlement is called.
    function buyViaRouter(uint256 buyerSeed, uint256 idSeed, bool overDeliver) external {
        address router = market.settlementRouter();
        if (router == address(0)) return;
        address buyer = buyers[buyerSeed % buyers.length];
        bytes32 id = listingIds[idSeed % listingIds.length];
        (address seller, uint256 price, bool active) = market.listings(id);
        if (seller == address(0) || !active || seller == buyer) return;
        if (market.hasPurchased(id, buyer)) return;

        uint256 sent = overDeliver ? price + 1e6 : price;
        if (sent > 0) {
            vm.prank(buyers[0]);
            usdc.transfer(address(market), sent);
        }
        ghostPaidIn += sent;

        vm.prank(router);
        market.purchaseFor(id, buyer, price);
    }

    /// Governance recovering stray/over-delivered funds must not break solvency.
    function sweep() external {
        if (market.unallocatedBalance() == 0) return;
        vm.prank(governor);
        uint256 amount = market.sweepUnallocated(platform);
        ghostPaidOut += amount;
    }

    function delistOne(uint256 sellerSeed, uint256 idSeed) external {
        address seller = sellers[sellerSeed % sellers.length];
        bytes32 id = listingIds[idSeed % listingIds.length];
        (address owner,,) = market.listings(id);
        if (owner != seller) return;
        vm.prank(seller);
        market.delist(id);
    }

    function withdrawAs(uint256 seed) external {
        address payee;
        uint256 pick = seed % (sellers.length + 1);
        payee = pick == sellers.length ? platform : sellers[pick];
        if (market.owed(payee) == 0) return;
        vm.prank(payee);
        uint256 amount = market.withdraw();
        ghostPaidOut += amount;
    }

    function changeFee(uint16 feeBps) external {
        feeBps = uint16(bound(feeBps, 0, market.MAX_FEE_BPS()));
        vm.prank(governor);
        market.setFeeBps(feeBps);
    }

    function sellerCount() external view returns (uint256) {
        return sellers.length;
    }
}

contract MarketplacePaymentsInvariantTest is StdInvariant, Test {
    MockUSDC internal usdc;
    MarketplacePayments internal market;
    MarketplaceHandler internal handler;

    address internal governor = makeAddr("governor");
    address internal platform = makeAddr("platform");

    function setUp() public {
        usdc = new MockUSDC();
        market = new MarketplacePayments(address(usdc), platform, governor, 2000);
        handler = new MarketplaceHandler(market, usdc, governor, platform);

        // Funded here rather than in the handler: MockUSDC gates mint to its owner,
        // which is this test contract.
        for (uint256 i = 0; i < handler.buyerCount(); i++) {
            address buyer = handler.buyers(i);
            usdc.mint(buyer, 1_000_000e6);
            vm.prank(buyer);
            usdc.approve(address(market), type(uint256).max);
        }

        // Exercise the org-funded rail alongside the direct one.
        vm.prank(governor);
        market.setSettlementRouter(makeAddr("router"));

        targetContract(address(handler));
    }

    /// @notice The contract can always pay everyone it owes. This is the property a
    ///         seller is trusting when they leave a balance accrued.
    function invariant_solventForAllDebts() public view {
        assertGe(usdc.balanceOf(address(market)), market.totalOwed());
    }

    /// @notice Balance is exactly what came in minus what went out — the contract
    ///         neither mints nor strands value.
    function invariant_balanceIsPaidInMinusPaidOut() public view {
        assertEq(
            usdc.balanceOf(address(market)), handler.ghostPaidIn() - handler.ghostPaidOut()
        );
    }

    /// @notice Individual balances always sum to the tracked total.
    function invariant_owedSumsToTotalOwed() public view {
        uint256 sum = market.owed(platform);
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            sum += market.owed(handler.sellers(i));
        }
        assertEq(sum, market.totalOwed());
    }

    /// @notice The take rate can never exceed the ceiling sellers listed under.
    function invariant_feeNeverExceedsCeiling() public view {
        assertLe(market.feeBps(), market.MAX_FEE_BPS());
    }
}
