// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MarketplacePayments
/// @notice Stablecoin settlement for marketplace listings: the buyer pays once, the
///         platform fee is split off, and the seller's share accrues for withdrawal.
/// @dev Deliberately independent of Treasury and EscalationRouter. Those govern what an
///      *org* may spend; this governs what a *buyer* pays a *seller*, which is a different
///      trust relationship — a marketplace purchase must not be able to touch org allowances.
///
///      The split is onchain because both sides must be able to verify it. `feeBps` is
///      governable but hard-capped at `MAX_FEE_BPS`, so no governor action can raise the
///      take rate past a bound a seller agreed to when they listed.
///
///      Sellers are paid by accrual (`owed` + `withdraw`) rather than a push transfer.
///      A push to a seller the stablecoin has blocklisted would revert and take the
///      buyer's purchase down with it; accrual keeps one seller's problem their own.
contract MarketplacePayments {
    using SafeERC20 for IERC20;

    /// @notice Settlement asset (USDC in production, MockUSDC on Anvil). 6 decimals.
    IERC20 public immutable token;

    /// @notice Hard ceiling on the platform fee, in basis points. Not governable.
    /// @dev The point of the ceiling is that it is unreachable by governance: a seller
    ///      listing today knows the worst case forever.
    uint16 public constant MAX_FEE_BPS = 3000;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Current platform fee in basis points (2000 = 20%).
    uint16 public feeBps;

    /// @notice Where platform fees accrue. Withdraws like any other payee.
    address public feeRecipient;

    /// @notice May change the fee, the fee recipient, and itself.
    address public governor;

    struct Listing {
        address seller;
        /// @dev Price in token base units (USDC micros). Zero is a valid free listing.
        uint256 price;
        bool active;
    }

    /// @notice Listing id is `keccak256(catalogId)` — the catalog stays off-chain.
    mapping(bytes32 => Listing) public listings;

    /// @notice Purchase receipts. Non-zero is proof of entitlement and its timestamp.
    mapping(bytes32 => mapping(address => uint64)) public purchasedAt;

    /// @notice Withdrawable balance per payee (sellers and the fee recipient alike).
    mapping(address => uint256) public owed;

    /// @notice Sum of `owed`. Lets anyone check the contract is solvent for its debts.
    uint256 public totalOwed;

    event ListingRegistered(bytes32 indexed listingId, address indexed seller, uint256 price);
    event ListingDelisted(bytes32 indexed listingId, address indexed seller);
    event ListingPurchased(
        bytes32 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 gross,
        uint256 fee,
        uint256 net
    );
    event Withdrawn(address indexed payee, uint256 amount);
    event FeeUpdated(uint16 feeBps);
    event FeeRecipientUpdated(address indexed feeRecipient);
    event GovernorUpdated(address indexed governor);

    error ZeroAddress();
    error FeeTooHigh(uint16 requested, uint16 max);
    error NotGovernor(address caller);
    error NotSeller(address caller, address seller);
    error ListingNotFound(bytes32 listingId);
    error ListingInactive(bytes32 listingId);
    error AlreadyPurchased(bytes32 listingId, address buyer);
    error PriceExceedsMax(uint256 price, uint256 maxPrice);
    error SellerCannotBuy(bytes32 listingId);
    error NothingOwed(address payee);

    constructor(address token_, address feeRecipient_, address governor_, uint16 feeBps_) {
        if (token_ == address(0) || feeRecipient_ == address(0) || governor_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        token = IERC20(token_);
        feeRecipient = feeRecipient_;
        governor = governor_;
        feeBps = feeBps_;
    }

    // ——— Selling ———

    /// @notice List `listingId` for `price`, or update the price of one you already own.
    /// @dev The seller is bound on first registration; a different caller can never take
    ///      over an id, so a catalog id cannot be hijacked to redirect payment.
    function registerListing(bytes32 listingId, uint256 price) external {
        Listing storage l = listings[listingId];
        if (l.seller == address(0)) {
            l.seller = msg.sender;
        } else if (l.seller != msg.sender) {
            revert NotSeller(msg.sender, l.seller);
        }
        l.price = price;
        l.active = true;
        emit ListingRegistered(listingId, msg.sender, price);
    }

    /// @notice Stop new purchases. Existing receipts and accrued balances are untouched.
    function delist(bytes32 listingId) external {
        Listing storage l = listings[listingId];
        if (l.seller == address(0)) revert ListingNotFound(listingId);
        if (l.seller != msg.sender && msg.sender != governor) revert NotSeller(msg.sender, l.seller);
        l.active = false;
        emit ListingDelisted(listingId, l.seller);
    }

    // ——— Buying ———

    /// @notice Buy `listingId`, paying at most `maxPrice`.
    /// @dev `maxPrice` is not optional convenience: without it a seller could raise the
    ///      price in the same block a buyer submits and collect the difference.
    function purchase(bytes32 listingId, uint256 maxPrice) external {
        Listing memory l = listings[listingId];
        if (l.seller == address(0)) revert ListingNotFound(listingId);
        if (!l.active) revert ListingInactive(listingId);
        if (l.seller == msg.sender) revert SellerCannotBuy(listingId);
        if (purchasedAt[listingId][msg.sender] != 0) {
            revert AlreadyPurchased(listingId, msg.sender);
        }
        if (l.price > maxPrice) revert PriceExceedsMax(l.price, maxPrice);

        // Receipt is written before any transfer, so a reentrant call sees the purchase
        // as already made rather than buying twice.
        purchasedAt[listingId][msg.sender] = uint64(block.timestamp);

        uint256 fee = (l.price * feeBps) / BPS_DENOMINATOR;
        uint256 net = l.price - fee;

        if (l.price > 0) {
            owed[l.seller] += net;
            owed[feeRecipient] += fee;
            totalOwed += l.price;
            token.safeTransferFrom(msg.sender, address(this), l.price);
        }

        emit ListingPurchased(listingId, msg.sender, l.seller, l.price, fee, net);
    }

    // ——— Settlement ———

    /// @notice Withdraw everything accrued to the caller.
    function withdraw() external returns (uint256 amount) {
        amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed(msg.sender);
        owed[msg.sender] = 0;
        totalOwed -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ——— Governance ———

    function setFeeBps(uint16 feeBps_) external {
        _onlyGovernor();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function setFeeRecipient(address feeRecipient_) external {
        _onlyGovernor();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        emit FeeRecipientUpdated(feeRecipient_);
    }

    function setGovernor(address governor_) external {
        _onlyGovernor();
        if (governor_ == address(0)) revert ZeroAddress();
        governor = governor_;
        emit GovernorUpdated(governor_);
    }

    // ——— Views ———

    /// @notice What a buyer would pay and how it splits, at the current fee.
    function quote(bytes32 listingId) external view returns (uint256 gross, uint256 fee, uint256 net) {
        gross = listings[listingId].price;
        fee = (gross * feeBps) / BPS_DENOMINATOR;
        net = gross - fee;
    }

    function hasPurchased(bytes32 listingId, address buyer) external view returns (bool) {
        return purchasedAt[listingId][buyer] != 0;
    }

    /// @notice Balance beyond what is owed to payees. Should be zero in normal operation;
    ///         a non-zero value means someone transferred tokens in directly.
    function unallocatedBalance() external view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > totalOwed ? bal - totalOwed : 0;
    }

    function _onlyGovernor() private view {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
    }
}
