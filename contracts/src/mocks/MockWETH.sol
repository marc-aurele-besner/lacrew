// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWETH
/// @notice 18-decimal ERC-20 for local / Anvil / testnet scaffolding — a second
///         asset alongside MockUSDC so multi-asset orgs (SPEC §4.1) can be
///         exercised end to end.
/// @dev Mint is restricted to the deployer + approved minters (deploy scripts);
///      everyone else uses the rate-limited faucet. Still not real WETH.
contract MockWETH is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    address public immutable owner;
    mapping(address => bool) public minters;
    mapping(address => uint256) public lastFaucetAt;

    event MinterUpdated(address indexed account, bool allowed);
    event FaucetDrip(address indexed to, uint256 amount);

    error NotMinter(address caller);
    error NotOwner(address caller);
    error FaucetCooldown(address caller, uint256 availableAt);

    constructor() ERC20("Mock WETH", "mWETH") {
        owner = msg.sender;
    }

    /// @notice Allow or revoke a minter (deploy scripts, dedicated faucets).
    function setMinter(address account, bool allowed) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        minters[account] = allowed;
        emit MinterUpdated(account, allowed);
    }

    /// @notice Unbounded mint for the deployer and approved minters only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner && !minters[msg.sender]) revert NotMinter(msg.sender);
        _mint(to, amount);
    }

    /// @notice Capped self-serve drip for testnet users (per-address cooldown).
    function faucet() external {
        uint256 availableAt = lastFaucetAt[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucetAt[msg.sender] != 0 && block.timestamp < availableAt) {
            revert FaucetCooldown(msg.sender, availableAt);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetDrip(msg.sender, FAUCET_AMOUNT);
    }
}
