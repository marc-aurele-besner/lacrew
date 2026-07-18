// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Treasury} from "./Treasury.sol";

/// @title EpochStreamer
/// @notice Payroll-style job: streams fixed grants to configured nodes once per epoch.
/// @dev Authorized as Treasury.streamer. Operator runs epochs; grant schedule can also
///      be mutated by `governor` (GovernanceModule) for constitutional budget changes.
contract EpochStreamer {
    Treasury public immutable treasury;
    address public operator;
    /// @notice When non-zero, may call `setGrant` (typically GovernanceModule).
    address public governor;

    uint64 public currentEpoch;
    mapping(address => uint256) public grantAmount;
    address[] private _recipients;
    mapping(address => bool) private _isRecipient;
    mapping(uint64 => bool) public epochCompleted;

    event OperatorUpdated(address indexed operator);
    event GovernorUpdated(address indexed governor);
    event GrantUpdated(address indexed node, uint256 amount);
    event EpochRun(uint64 indexed epoch, uint256 recipientCount);

    error NotOperator(address caller);
    error NotAuthorized(address caller);
    error EpochAlreadyRun(uint64 epoch);
    error ZeroAddress();
    error EmptySchedule();
    error GovernorAlreadySet();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    constructor(address treasury_, address operator_) {
        if (treasury_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        treasury = Treasury(treasury_);
        operator = operator_;
    }

    function setOperator(address operator_) external onlyOperator {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorUpdated(operator_);
    }

    /// @notice Bind constitutional authority for grant schedule. Callable once by operator.
    function setGovernor(address governor_) external onlyOperator {
        if (governor_ == address(0)) revert ZeroAddress();
        if (governor != address(0)) revert GovernorAlreadySet();
        governor = governor_;
        emit GovernorUpdated(governor_);
    }

    /// @notice Set (or clear with amount=0) the per-epoch grant for `node`.
    function setGrant(address node, uint256 amount) external {
        if (msg.sender != operator && msg.sender != governor) revert NotAuthorized(msg.sender);
        if (node == address(0)) revert ZeroAddress();
        if (amount == 0) {
            if (_isRecipient[node]) {
                _isRecipient[node] = false;
                grantAmount[node] = 0;
                _removeRecipient(node);
            }
        } else {
            grantAmount[node] = amount;
            if (!_isRecipient[node]) {
                _isRecipient[node] = true;
                _recipients.push(node);
            }
        }
        emit GrantUpdated(node, amount);
    }

    function recipients() external view returns (address[] memory) {
        return _recipients;
    }

    /// @notice Advance `currentEpoch` and stream all grants. Idempotent per epoch id.
    function runNextEpoch() external onlyOperator returns (uint64 epoch) {
        epoch = currentEpoch + 1;
        _runEpoch(epoch);
        currentEpoch = epoch;
    }

    /// @notice Stream grants for an explicit epoch id (must not have run before).
    function runEpoch(uint64 epoch) external onlyOperator {
        _runEpoch(epoch);
        if (epoch > currentEpoch) currentEpoch = epoch;
    }

    function _runEpoch(uint64 epoch) private {
        if (epochCompleted[epoch]) revert EpochAlreadyRun(epoch);
        uint256 n = _recipients.length;
        if (n == 0) revert EmptySchedule();

        epochCompleted[epoch] = true;
        for (uint256 i = 0; i < n; i++) {
            address node = _recipients[i];
            uint256 amount = grantAmount[node];
            if (amount == 0) continue;
            treasury.streamAllowance(node, amount, epoch);
        }
        emit EpochRun(epoch, n);
    }

    function _removeRecipient(address node) private {
        uint256 n = _recipients.length;
        for (uint256 i = 0; i < n; i++) {
            if (_recipients[i] == node) {
                _recipients[i] = _recipients[n - 1];
                _recipients.pop();
                return;
            }
        }
    }
}
