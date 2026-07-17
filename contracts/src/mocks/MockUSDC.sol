// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal ERC-20 for local / Anvil / testnet scaffolding.
/// @dev Mocked: permissionless mint for demos. Do not use as a real stablecoin.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// TODO: Restrict mint to faucet / deploy scripts only before public testnets hold value.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
