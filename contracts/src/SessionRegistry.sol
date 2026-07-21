// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SessionScopes} from "./SessionScopes.sol";

/// @title SessionRegistry
/// @notice Onchain registry of scoped, expiring agent session keys.
/// @dev Phase 0 bridge before ERC-4337 session modules (F1.3). Root issues and revokes;
///      orchestrator holds only the ephemeral private key off-chain.
///      EscalationRouter enforces `scopeMask`, `maxValue`, and optional
///      `allowedTarget` (`address(0)` = any target that still passes policy).
///
///      Scopes are a bitmask so the chain can test membership on its own. A
///      digest of the scope list could not be gated on without the caller also
///      supplying the preimage, which would let the caller pick the answer.
contract SessionRegistry {
    /// @notice Mirrors of `SessionScopes`, exposed so off-chain callers can read
    ///         the vocabulary from the deployment they are actually talking to.
    uint256 public constant SCOPE_PROPOSE_INTENT = SessionScopes.PROPOSE_INTENT;
    uint256 public constant SCOPE_SPEND_WHITELIST = SessionScopes.SPEND_WHITELIST;
    /// @dev Anything outside this is rejected at issue time, so a typo'd scope
    ///      cannot be mistaken for a granted one.
    uint256 public constant SCOPE_ALL = SessionScopes.ALL;

    struct Session {
        address agent;
        address key;
        uint64 expiresAt;
        uint256 scopeMask;
        uint256 maxValue;
        address allowedTarget;
        bool revoked;
        bool exists;
    }

    address public immutable humanRoot;
    /// @notice Optional issuer (orchestrator EOA). Defaults to humanRoot.
    address public issuer;

    uint256 public nextSessionId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(address => uint256[]) private _byAgent;
    /// @dev agent => key => sessionId (0 = none / cleared)
    mapping(address => mapping(address => uint256)) public activeKeySession;
    /// @dev sessionId => pinned targets (empty = any policy-allowed target)
    mapping(uint256 => address[]) private _sessionTargets;
    mapping(uint256 => mapping(address => bool)) private _targetAllowed;

    event IssuerUpdated(address indexed issuer);
    event SessionIssued(
        uint256 indexed sessionId,
        address indexed agent,
        address indexed key,
        uint64 expiresAt,
        uint256 scopeMask,
        uint256 maxValue,
        address allowedTarget
    );
    event SessionRevoked(uint256 indexed sessionId, address indexed by);
    /// @notice Emitted alongside SessionIssued when more than one target is pinned.
    event SessionTargetsPinned(uint256 indexed sessionId, address[] targets);

    error NotAuthorized(address caller);
    error ZeroAddress();
    error InvalidExpiry(uint64 expiresAt);
    error SessionNotFound(uint256 sessionId);
    error AlreadyRevoked(uint256 sessionId);
    /// @dev An empty mask would be a session that can do nothing; an unknown bit
    ///      is almost always a caller encoding scopes against a newer vocabulary.
    error InvalidScopeMask(uint256 scopeMask);

    modifier onlyRootOrIssuer() {
        if (msg.sender != humanRoot && msg.sender != issuer) revert NotAuthorized(msg.sender);
        _;
    }

    constructor(address humanRoot_) {
        if (humanRoot_ == address(0)) revert ZeroAddress();
        humanRoot = humanRoot_;
        issuer = humanRoot_;
    }

    function setIssuer(address issuer_) external {
        if (msg.sender != humanRoot) revert NotAuthorized(msg.sender);
        if (issuer_ == address(0)) revert ZeroAddress();
        issuer = issuer_;
        emit IssuerUpdated(issuer_);
    }

    /// @notice Register an ephemeral key for `agent` until `expiresAt` (unix seconds).
    /// @param maxValue Max propose value (`type(uint256).max` = unlimited).
    /// @param allowedTarget Sole allowed target (`address(0)` = any policy-allowed target).
    function issue(
        address agent,
        address key,
        uint64 expiresAt,
        uint256 scopeMask,
        uint256 maxValue,
        address allowedTarget
    ) external onlyRootOrIssuer returns (uint256 sessionId) {
        address[] memory targets;
        if (allowedTarget != address(0)) {
            targets = new address[](1);
            targets[0] = allowedTarget;
        }
        return _issue(agent, key, expiresAt, scopeMask, maxValue, targets);
    }

    /// @notice Issue a session pinned to several targets (empty = any policy-allowed target).
    /// @dev Multi-target sessions are checked with `isTargetAllowed`; `keyLimits`
    ///      reports only the first target so naive consumers fail closed.
    function issueScoped(
        address agent,
        address key,
        uint64 expiresAt,
        uint256 scopeMask,
        uint256 maxValue,
        address[] calldata allowedTargets
    ) external onlyRootOrIssuer returns (uint256 sessionId) {
        return _issue(agent, key, expiresAt, scopeMask, maxValue, allowedTargets);
    }

    function _issue(
        address agent,
        address key,
        uint64 expiresAt,
        uint256 scopeMask,
        uint256 maxValue,
        address[] memory allowedTargets
    ) private returns (uint256 sessionId) {
        if (agent == address(0) || key == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);
        if (scopeMask == 0 || scopeMask & ~SessionScopes.ALL != 0) revert InvalidScopeMask(scopeMask);

        // Revoke any prior active session for this key binding.
        uint256 prior = activeKeySession[agent][key];
        if (prior != 0 && !sessions[prior].revoked) {
            sessions[prior].revoked = true;
            emit SessionRevoked(prior, msg.sender);
        }

        sessionId = nextSessionId++;
        address first;
        for (uint256 i = 0; i < allowedTargets.length; i++) {
            address t = allowedTargets[i];
            if (t == address(0)) revert ZeroAddress();
            if (_targetAllowed[sessionId][t]) continue;
            _targetAllowed[sessionId][t] = true;
            _sessionTargets[sessionId].push(t);
            if (first == address(0)) first = t;
        }

        sessions[sessionId] = Session({
            agent: agent,
            key: key,
            expiresAt: expiresAt,
            scopeMask: scopeMask,
            maxValue: maxValue,
            allowedTarget: first,
            revoked: false,
            exists: true
        });
        _byAgent[agent].push(sessionId);
        activeKeySession[agent][key] = sessionId;

        emit SessionIssued(sessionId, agent, key, expiresAt, scopeMask, maxValue, first);
        if (_sessionTargets[sessionId].length > 1) {
            emit SessionTargetsPinned(sessionId, _sessionTargets[sessionId]);
        }
    }

    /// @notice Root (or issuer) revokes a session. Product rule: prefer root-driven revoke.
    function revoke(uint256 sessionId) external onlyRootOrIssuer {
        Session storage s = sessions[sessionId];
        if (!s.exists) revert SessionNotFound(sessionId);
        if (s.revoked) revert AlreadyRevoked(sessionId);
        s.revoked = true;
        if (activeKeySession[s.agent][s.key] == sessionId) {
            activeKeySession[s.agent][s.key] = 0;
        }
        emit SessionRevoked(sessionId, msg.sender);
    }

    function isValid(uint256 sessionId) public view returns (bool) {
        Session storage s = sessions[sessionId];
        if (!s.exists || s.revoked) return false;
        return block.timestamp < s.expiresAt;
    }

    function isKeyValid(address agent, address key) external view returns (bool) {
        uint256 id = activeKeySession[agent][key];
        if (id == 0) return false;
        return isValid(id);
    }

    /// @notice Limits for an active key. `valid` is false when missing/expired/revoked.
    /// @dev `allowedTarget` is the FIRST pinned target; multi-target sessions must be
    ///      checked with `isTargetAllowed` (naive consumers therefore fail closed).
    function keyLimits(address agent, address key)
        external
        view
        returns (bool valid, uint256 maxValue, address allowedTarget, uint256 scopeMask)
    {
        uint256 id = activeKeySession[agent][key];
        if (id == 0) return (false, 0, address(0), 0);
        Session storage s = sessions[id];
        if (!s.exists || s.revoked || block.timestamp >= s.expiresAt) {
            return (false, 0, address(0), 0);
        }
        return (true, s.maxValue, s.allowedTarget, s.scopeMask);
    }

    /// @notice Targets pinned to a session (empty = any policy-allowed target).
    function allowedTargetsOf(uint256 sessionId) external view returns (address[] memory) {
        return _sessionTargets[sessionId];
    }

    /// @notice Whether an active key may call `target`. Unpinned sessions allow any.
    function isTargetAllowed(address agent, address key, address target)
        external
        view
        returns (bool)
    {
        uint256 id = activeKeySession[agent][key];
        if (id == 0 || !isValid(id)) return false;
        if (_sessionTargets[id].length == 0) return true;
        return _targetAllowed[id][target];
    }

    function sessionsOf(address agent) external view returns (uint256[] memory) {
        return _byAgent[agent];
    }
}
