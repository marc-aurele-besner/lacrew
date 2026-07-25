// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MockUSDC
/// @notice 6-decimal ERC-20 for local / Anvil / testnet scaffolding.
/// @dev Mint is restricted to the deployer + approved minters (deploy scripts);
///      everyone else uses the rate-limited faucet. Still not a real stablecoin.
///      Implements EIP-3009 `transferWithAuthorization` the way Circle's
///      FiatTokenV2_2 does — a (v,r,s) overload for EOA payers and a bytes
///      overload checked via ERC-1271 for contract payers — so x402 settlement
///      (the lacrew x402 package) runs for real against local deployments.
contract MockUSDC is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    uint256 public constant FAUCET_AMOUNT = 100 * 1e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    address public immutable owner;
    mapping(address => bool) public minters;
    mapping(address => uint256) public lastFaucetAt;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event MinterUpdated(address indexed account, bool allowed);
    event FaucetDrip(address indexed to, uint256 amount);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error NotMinter(address caller);
    error NotOwner(address caller);
    error FaucetCooldown(address caller, uint256 availableAt);
    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationUsedOrCanceled(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSignature(address authorizer);

    constructor() ERC20("Mock USDC", "mUSDC") EIP712("Mock USDC", "1") {
        owner = msg.sender;
    }

    /// @notice EIP-712 domain version, readable the way Circle's token exposes it.
    function version() external pure returns (string memory) {
        return "1";
    }

    /// @notice EIP-712 domain separator, readable the way Circle's token exposes it.
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
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

    /// @notice Whether an authorization nonce was already used or canceled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice EIP-3009 transfer, (v,r,s) overload for EOA payers.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// @notice EIP-3009 transfer, bytes overload — ERC-1271 capable, so a Safe
    ///         or other contract account can be the payer.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    /// @notice Burn an unused authorization nonce so it can never settle.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationUsedOrCanceled(authorizer, nonce);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) {
            revert InvalidAuthorizationSignature(authorizer);
        }
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (_authorizationStates[from][nonce]) revert AuthorizationUsedOrCanceled(from, nonce);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            )
        );
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) {
            revert InvalidAuthorizationSignature(from);
        }
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
