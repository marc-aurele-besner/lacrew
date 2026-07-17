// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Treasury
/// @notice Holds org ERC-20 funds and streams allowances downward on epoch schedules.
/// @dev Token stays in this contract until spent; `allowanceBalance` is working-capital bookkeeping.
contract Treasury {
    using SafeERC20 for IERC20;

    address public immutable orgRegistry;
    IERC20 public immutable token;

    address public spender;
    uint256 public totalReserved;
    mapping(address => uint256) public allowanceBalance;

    event SpenderUpdated(address indexed spender);
    event Deposited(address indexed from, uint256 amount);
    event AllowanceStreamed(address indexed node, uint256 amount, uint64 epoch);
    event AllowanceSpent(address indexed node, uint256 amount, address indexed to);

    error InsufficientAllowance(address node, uint256 requested, uint256 available);
    error InsufficientTreasury(uint256 requested, uint256 available);
    error NotSpender(address caller);
    error ZeroAddress();

    constructor(address orgRegistry_, address token_, address spender_) {
        if (orgRegistry_ == address(0) || token_ == address(0)) revert ZeroAddress();
        orgRegistry = orgRegistry_;
        token = IERC20(token_);
        spender = spender_;
    }

    /// @notice Update who may call `spendAllowance` (typically EscalationRouter).
    /// @dev Mocked: permissionless for scaffolding; TODO: gate to GovernanceModule / root.
    function setSpender(address spender_) external {
        if (spender_ == address(0)) revert ZeroAddress();
        spender = spender_;
        emit SpenderUpdated(spender_);
    }

    /// @notice Deposit ERC-20 into the treasury (caller must approve first).
    function deposit(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Allocate `amount` of unreserved treasury balance to `node` for an epoch.
    /// @dev Mocked: anyone may stream; TODO: Restrict to epoch job / authorized streamer.
    function streamAllowance(address node, uint256 amount, uint64 epoch) external {
        uint256 liquid = liquidBalance();
        if (liquid < amount) revert InsufficientTreasury(amount, liquid);

        allowanceBalance[node] += amount;
        totalReserved += amount;
        emit AllowanceStreamed(node, amount, epoch);
    }

    /// @notice Debit `node` allowance and transfer tokens to `to`. Only `spender` may call.
    function spendAllowance(address node, uint256 amount, address to) external {
        if (msg.sender != spender) revert NotSpender(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        _spend(node, amount, to);
    }

    /// @notice Debit `node` allowance and transfer tokens to the spender (router).
    function spendAllowance(address node, uint256 amount) external {
        if (msg.sender != spender) revert NotSpender(msg.sender);
        _spend(node, amount, msg.sender);
    }

    function liquidBalance() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > totalReserved ? bal - totalReserved : 0;
    }

    function _spend(address node, uint256 amount, address to) private {
        uint256 available = allowanceBalance[node];
        if (available < amount) revert InsufficientAllowance(node, amount, available);
        allowanceBalance[node] = available - amount;
        totalReserved -= amount;
        token.safeTransfer(to, amount);
        emit AllowanceSpent(node, amount, to);
    }
}
