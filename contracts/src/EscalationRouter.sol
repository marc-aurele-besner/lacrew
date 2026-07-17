// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "./interfaces/IPolicyModule.sol";
import {IOrgRegistry} from "./interfaces/IOrgRegistry.sol";

/// @title EscalationRouter
/// @notice Creates pending intents when a policy returns ESCALATE; parents approve upward.
/// @dev Mocked: stores intents in a mapping; no session-key / account execution yet.
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

    uint256 public nextIntentId = 1;
    mapping(uint256 => Intent) public intents;

    event IntentCreated(uint256 indexed intentId, address indexed agent, address awaitingApprover);
    event IntentEscalated(uint256 indexed intentId, address indexed from, address indexed to);
    event IntentResolved(uint256 indexed intentId, bool approved);

    error IntentNotFound(uint256 intentId);
    error IntentAlreadyResolved(uint256 intentId);
    error NotAwaitingApprover(address caller);
    error UnexpectedVerdict(Verdict verdict);
    error NoApprover(address agent);

    /// TODO: Support stacked policy modules per node instead of a single global policy.
    constructor(address orgRegistry_, address policy_) {
        orgRegistry = IOrgRegistry(orgRegistry_);
        policy = IPolicyModule(policy_);
    }

    /// @notice Propose an action; ALLOW is a no-op stub, ESCALATE creates an intent, DENY reverts.
    /// @dev Mocked: ALLOW does not execute the call onchain.
    /// TODO: On ALLOW, route through the agent smart account / session key module.
    function propose(
        address agent,
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (uint256 intentId, Verdict verdict) {
        verdict = policy.check(agent, target, value, data);

        if (verdict == Verdict.DENY) {
            revert UnexpectedVerdict(verdict);
        }

        if (verdict == Verdict.ALLOW) {
            return (0, verdict);
        }

        IOrgRegistry.Node memory node = orgRegistry.getNode(agent);
        if (node.parent == address(0)) revert NoApprover(agent);

        intentId = nextIntentId++;
        intents[intentId] = Intent({
            agent: agent,
            target: target,
            value: value,
            data: data,
            awaitingApprover: node.parent,
            resolved: false,
            approved: false
        });

        emit IntentCreated(intentId, agent, node.parent);
    }

    /// @notice Parent approves or rejects a pending intent.
    /// @dev On approve, re-checks policy as the approver: ALLOW finalizes, ESCALATE climbs, DENY rejects.
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

        // Re-evaluate as if the approver were the acting agent (purchase-order authority).
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
            emit IntentResolved(intentId, true);
            return;
        }

        // ESCALATE — climb to the approver's parent (ultimately the human root).
        IOrgRegistry.Node memory approver = orgRegistry.getNode(msg.sender);
        if (approver.parent == address(0) || approver.kind == IOrgRegistry.NodeKind.HumanRoot) {
            // Root reserved authority: human passkey approval finalizes high-tier overages.
            // Mocked: treat root approval as final ALLOW.
            intent.resolved = true;
            intent.approved = true;
            emit IntentResolved(intentId, true);
            return;
        }

        address nextApprover = approver.parent;
        address previous = intent.awaitingApprover;
        intent.awaitingApprover = nextApprover;
        emit IntentEscalated(intentId, previous, nextApprover);
    }
}
