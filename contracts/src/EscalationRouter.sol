// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyModule, Verdict} from "./interfaces/IPolicyModule.sol";
import {IOrgRegistry} from "./interfaces/IOrgRegistry.sol";
import {IRateRecorder} from "./interfaces/IRateRecorder.sol";
import {ITreasurySpender} from "./interfaces/ITreasurySpender.sol";
import {SessionRegistry} from "./SessionRegistry.sol";
import {SessionScopes} from "./SessionScopes.sol";

/// @title EscalationRouter
/// @notice Creates pending intents when a policy returns ESCALATE; parents approve upward.
/// @dev On ALLOW (propose or final resolve), optionally spends allowance and calls `target`.
///      When `sessionRegistry` is set, `propose` must be signed by a valid session key for `agent`
///      (or by `agent` itself for future AA EOAs).
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
    /// @notice Default policy stack when `policyOf[node]` is unset.
    IPolicyModule public policy;
    ITreasurySpender public treasury;
    IRateRecorder public rateRecorder;
    SessionRegistry public sessionRegistry;
    /// @notice Deployer. Holds bootstrap authority until `governor` is bound, so the
    ///         wiring window is not open to whoever sees the deployment first.
    address public immutable deployer;
    /// @notice GovernanceModule (or the deployer while bootstrapping) for the setters below.
    address public governor;

    uint256 public nextIntentId = 1;
    mapping(uint256 => Intent) public intents;
    /// @notice Optional per-node policy stack override (falls back to `policy`).
    mapping(address => IPolicyModule) public policyOf;
    /// @notice Optional per-node rate recorder (falls back to `rateRecorder`).
    /// A node bound to its own RateLimitPolicy needs its executed actions
    /// counted in that module's windows; the global recorder never sees them.
    mapping(address => IRateRecorder) public rateRecorderOf;

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
    event SessionRegistryUpdated(address indexed sessionRegistry);
    event NodePolicyUpdated(address indexed node, address indexed policyModule);
    event NodeRateRecorderUpdated(address indexed node, address indexed rateRecorder);
    event GovernorUpdated(address indexed governor);

    error IntentNotFound(uint256 intentId);
    error IntentAlreadyResolved(uint256 intentId);
    error NotAwaitingApprover(address caller);
    error UnexpectedVerdict(Verdict verdict);
    error NoApprover(address agent);
    error InactiveAgent(address agent);
    error NotAuthorized(address caller);
    error InvalidSession(address agent, address key);
    error SessionValueExceeded(address agent, uint256 value, uint256 maxValue);
    error SessionTargetDenied(address agent, address target, address allowedTarget);
    error SessionScopeDenied(address agent, uint256 required, uint256 granted);
    error SessionTimeWindowDenied(address agent);
    /// @dev The router is `Treasury.spender`, `SessionRegistry.escalationRouter` and the
    ///      bound recorder of its rate modules. Letting an agent aim a policy-admitted
    ///      call at one of those would lend it the router's own authority.
    error ProtectedTarget(address target);
    error ZeroAddress();

    constructor(address orgRegistry_, address policy_) {
        if (orgRegistry_ == address(0)) revert ZeroAddress();
        orgRegistry = IOrgRegistry(orgRegistry_);
        policy = IPolicyModule(policy_);
        deployer = msg.sender;
    }

    /// @notice Bind constitutional authority. The deployer binds it first; then only governor.
    function setGovernor(address governor_) external {
        if (governor_ == address(0)) revert ZeroAddress();
        _onlyGovernorOrBootstrap();
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

    /// @notice Wire SessionRegistry so propose requires a valid session key.
    function setSessionRegistry(address sessionRegistry_) external {
        _onlyGovernorOrBootstrap();
        sessionRegistry = SessionRegistry(sessionRegistry_);
        emit SessionRegistryUpdated(sessionRegistry_);
    }

    /// @notice Bind a policy stack to a node. Pass address(0) to clear (use default `policy`).
    function setNodePolicy(address node, address policyModule) external {
        _onlyGovernorOrBootstrap();
        if (node == address(0)) revert ZeroAddress();
        policyOf[node] = IPolicyModule(policyModule);
        emit NodePolicyUpdated(node, policyModule);
    }

    /// @notice Bind a node's own rate recorder (its custom RateLimitPolicy).
    /// Pass address(0) to clear (fall back to the global `rateRecorder`).
    function setNodeRateRecorder(address node, address rateRecorder_) external {
        _onlyGovernorOrBootstrap();
        if (node == address(0)) revert ZeroAddress();
        rateRecorderOf[node] = IRateRecorder(rateRecorder_);
        emit NodeRateRecorderUpdated(node, rateRecorder_);
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
        _requireUnprotectedTarget(agent, target);
        uint256 scopeMask = _requireValidSession(agent, target, value);
        // Count this propose against the key's rate limit (no-op unless wired and
        // the key has one). Reverts here roll back the count, so only a propose
        // that actually proceeds is charged.
        if (address(sessionRegistry) != address(0)) {
            sessionRegistry.recordProposal(agent, msg.sender);
        }

        verdict = _policyFor(agent).check(agent, target, value, data);

        if (verdict == Verdict.DENY) {
            revert UnexpectedVerdict(verdict);
        }

        if (verdict == Verdict.ALLOW) {
            // Settlement is a second grant. A policy ALLOW says the action is
            // within the org's rules; the spend scope says this particular key
            // is allowed to act on that without a human in the loop.
            _requireSpendScope(agent, scopeMask);
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

        Verdict verdict =
            _policyFor(msg.sender).check(msg.sender, intent.target, intent.value, intent.data);

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
            // Root reserved authority finalizes. A passkey root arrives here as
            // its own Safe: msg.sender is the Safe, and the credential authorized
            // this call through Safe.execTransaction, so the binding this comment
            // once deferred is the sender check on line 180 (F2.6 / F1.3).
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
        IRateRecorder recorder = rateRecorderOf[agent];
        if (address(recorder) == address(0)) recorder = rateRecorder;
        if (address(recorder) != address(0)) {
            recorder.record(agent);
        }
    }

    /// @dev Unset registry = unit-test bootstrap. Otherwise: valid session + scope
    ///      + maxValue + target. Returns the granted scope mask so the caller can
    ///      gate settlement separately; `type(uint256).max` when the registry is
    ///      unset or the agent is acting for itself (no session to narrow it).
    function _requireValidSession(address agent, address target, uint256 value)
        private
        view
        returns (uint256 scopeMask)
    {
        if (address(sessionRegistry) == address(0)) return type(uint256).max;
        if (msg.sender == agent) return type(uint256).max;
        bool valid;
        uint256 maxValue;
        address allowedTarget;
        (valid, maxValue, allowedTarget, scopeMask) =
            sessionRegistry.keyLimits(agent, msg.sender);
        if (!valid) revert InvalidSession(agent, msg.sender);
        if (scopeMask & SessionScopes.PROPOSE_INTENT == 0) {
            revert SessionScopeDenied(agent, SessionScopes.PROPOSE_INTENT, scopeMask);
        }
        if (value > maxValue) revert SessionValueExceeded(agent, value, maxValue);
        // Handles both single- and multi-target pins (unpinned = any policy-allowed
        // target); `allowedTarget` is reported only for the revert reason.
        if (!sessionRegistry.isTargetAllowed(agent, msg.sender, target)) {
            revert SessionTargetDenied(agent, target, allowedTarget);
        }
        // A key issued with a daily window can only propose inside it — the flow's
        // time-window scope enforced by the chain, not just the orchestrator.
        if (!sessionRegistry.withinTimeWindow(agent, msg.sender)) {
            revert SessionTimeWindowDenied(agent);
        }
    }

    /// @dev `type(uint256).max` from `_requireValidSession` means no session is
    ///      narrowing this call, so every bit is granted and this passes.
    function _requireSpendScope(address agent, uint256 scopeMask) private view {
        if (address(sessionRegistry) == address(0)) return;
        if (scopeMask & SessionScopes.SPEND_WHITELIST == 0) {
            revert SessionScopeDenied(agent, SessionScopes.SPEND_WHITELIST, scopeMask);
        }
    }

    /// @dev Policy decides what an agent may call; this only refuses the contracts
    ///      that trust the router as `msg.sender`, whatever the policy says. Checked
    ///      at propose so no such intent can even be created for a parent to approve.
    function _requireUnprotectedTarget(address agent, address target) private view {
        // Unwired slots are zero; a zero target must not match them.
        if (target == address(0)) return;
        if (
            target == address(this) || target == address(treasury)
                || target == address(sessionRegistry) || target == address(rateRecorder)
                || target == address(rateRecorderOf[agent])
        ) {
            revert ProtectedTarget(target);
        }
    }

    function _policyFor(address node) private view returns (IPolicyModule) {
        IPolicyModule nodePolicy = policyOf[node];
        if (address(nodePolicy) != address(0)) return nodePolicy;
        return policy;
    }

    /// @dev Governor once bound; the deployer until then.
    function _onlyGovernorOrBootstrap() private view {
        address authority = governor == address(0) ? deployer : governor;
        if (msg.sender != authority) revert NotAuthorized(msg.sender);
    }
}
