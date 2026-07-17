// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "./interfaces/IPolicyModule.sol";
import {IOrgRegistry} from "./interfaces/IOrgRegistry.sol";
import {IRateRecorder} from "./interfaces/IRateRecorder.sol";
import {ITreasurySpender} from "./interfaces/ITreasurySpender.sol";

/// @title EscalationRouter
/// @notice Creates pending intents when a policy returns ESCALATE; parents approve upward.
/// @dev On ALLOW (propose or final resolve), optionally spends allowance and calls `target`.
contract EscalationRouter {
    struct Intent {
        address agent;
        address target;
        uint256 value;
        bytes data;
        address awaitingApprover;
        bool resolved;
        bool approved;
    }

    IOrgRegistry public immutable orgRegistry;
    IPolicyModule public policy;
    ITreasurySpender public treasury;
    IRateRecorder public rateRecorder;
    /// @notice GovernanceModule (or bootstrap) for setTreasury / setRateRecorder.
    address public governor;

    uint256 public nextIntentId = 1;
    mapping(uint256 => Intent) public intents;

    event IntentCreated(uint256 indexed intentId, address indexed agent, address awaitingApprover);
    event IntentEscalated(uint256 indexed intentId, address indexed from, address indexed to);
    event IntentResolved(uint256 indexed intentId, bool approved);
    event ActionExecuted(
        address indexed agent,
        address indexed target,
        uint256 value,
        bool callOk
    );
    event TreasuryUpdated(address indexed treasury);
    event RateRecorderUpdated(address indexed rateRecorder);
    event GovernorUpdated(address indexed governor);

    error IntentNotFound(uint256 intentId);
    error IntentAlreadyResolved(uint256 intentId);
    error NotAwaitingApprover(address caller);
    error UnexpectedVerdict(Verdict verdict);
    error NoApprover(address agent);
    error InactiveAgent(address agent);
    error NotAuthorized(address caller);
    error ZeroAddress();

    /// TODO: Support stacked policy modules per node instead of a single global policy.
    constructor(address orgRegistry_, address policy_) {
        orgRegistry = IOrgRegistry(orgRegistry_);
        policy = IPolicyModule(policy_);
    }

    /// @notice Bind constitutional authority. First set is bootstrap; then only governor.
    function setGovernor(address governor_) external {
        if (governor_ == address(0)) revert ZeroAddress();
        if (governor != address(0) && msg.sender != governor) revert NotAuthorized(msg.sender);
        governor = governor_;
        emit GovernorUpdated(governor_);
    }

    /// @notice Wire treasury for ALLOW execution.
    function setTreasury(address treasury_) external {
        _onlyGovernorOrBootstrap();
        treasury = ITreasurySpender(treasury_);
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Wire rate-limit recorder.
    function setRateRecorder(address rateRecorder_) external {
        _onlyGovernorOrBootstrap();
        rateRecorder = IRateRecorder(rateRecorder_);
        emit RateRecorderUpdated(rateRecorder_);
    }

    /// @notice Propose an action; ALLOW executes spend+call, ESCALATE creates an intent, DENY reverts.
    function propose(
        address agent,
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (uint256 intentId, Verdict verdict) {
        IOrgRegistry.Node memory agentNode = orgRegistry.getNode(agent);
        if (!agentNode.active) revert InactiveAgent(agent);

        verdict = policy.check(agent, target, value, data);

        if (verdict == Verdict.DENY) {
            revert UnexpectedVerdict(verdict);
        }

        if (verdict == Verdict.ALLOW) {
            _finalizeAction(agent, target, value, data);
            return (0, verdict);
        }

        if (agentNode.parent == address(0)) revert NoApprover(agent);

        intentId = nextIntentId++;
        intents[intentId] = Intent({
            agent: agent,
            target: target,
            value: value,
            data: data,
            awaitingApprover: agentNode.parent,
            resolved: false,
            approved: false
        });

        _recordRate(agent);
        emit IntentCreated(intentId, agent, agentNode.parent);
    }

    /// @notice Parent approves or rejects a pending intent.
    function resolve(uint256 intentId, bool approved) external {
        Intent storage intent = intents[intentId];
        if (intent.agent == address(0)) revert IntentNotFound(intentId);
        if (intent.resolved) revert IntentAlreadyResolved(intentId);
        if (msg.sender != intent.awaitingApprover) revert NotAwaitingApprover(msg.sender);

        if (!approved) {
            intent.resolved = true;
            intent.approved = false;
            emit IntentResolved(intentId, false);
            return;
        }

        Verdict verdict = policy.check(msg.sender, intent.target, intent.value, intent.data);

        if (verdict == Verdict.DENY) {
            intent.resolved = true;
            intent.approved = false;
            emit IntentResolved(intentId, false);
            return;
        }

        if (verdict == Verdict.ALLOW) {
            intent.resolved = true;
            intent.approved = true;
            _finalizeAction(intent.agent, intent.target, intent.value, intent.data);
            emit IntentResolved(intentId, true);
            return;
        }

        IOrgRegistry.Node memory approver = orgRegistry.getNode(msg.sender);
        if (approver.parent == address(0) || approver.kind == IOrgRegistry.NodeKind.HumanRoot) {
            // Root reserved authority finalizes; passkey binding is off-chain / AA (TODO).
            intent.resolved = true;
            intent.approved = true;
            _finalizeAction(intent.agent, intent.target, intent.value, intent.data);
            emit IntentResolved(intentId, true);
            return;
        }

        address nextApprover = approver.parent;
        address previous = intent.awaitingApprover;
        intent.awaitingApprover = nextApprover;
        emit IntentEscalated(intentId, previous, nextApprover);
    }

    function _finalizeAction(
        address agent,
        address target,
        uint256 value,
        bytes memory data
    ) private {
        if (address(treasury) != address(0) && value > 0) {
            treasury.spendAllowance(agent, value, target);
        }

        bool callOk = true;
        if (data.length > 0) {
            (callOk, ) = target.call(data);
        }
        _recordRate(agent);
        emit ActionExecuted(agent, target, value, callOk);
    }

    function _recordRate(address agent) private {
        if (address(rateRecorder) != address(0)) {
            rateRecorder.record(agent);
        }
    }

    function _onlyGovernorOrBootstrap() private view {
        if (governor != address(0) && msg.sender != governor) revert NotAuthorized(msg.sender);
    }
}
