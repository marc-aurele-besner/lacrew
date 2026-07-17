// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title SessionRegistry
/// @notice Onchain registry of scoped, expiring agent session keys.
/// @dev Phase 0 bridge before ERC-4337 session modules (F1.3). Root issues and revokes;
///      orchestrator holds only the ephemeral private key off-chain.
contract SessionRegistry {
    struct Session {
        address agent;
        address key;
        uint64 expiresAt;
        bytes32 scopesHash;
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

    event IssuerUpdated(address indexed issuer);
    event SessionIssued(
        uint256 indexed sessionId,
        address indexed agent,
        address indexed key,
        uint64 expiresAt,
        bytes32 scopesHash
    );
    event SessionRevoked(uint256 indexed sessionId, address indexed by);

    error NotAuthorized(address caller);
    error ZeroAddress();
    error InvalidExpiry(uint64 expiresAt);
    error SessionNotFound(uint256 sessionId);
    error AlreadyRevoked(uint256 sessionId);

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
    function issue(
        address agent,
        address key,
        uint64 expiresAt,
        bytes32 scopesHash
    ) external onlyRootOrIssuer returns (uint256 sessionId) {
        if (agent == address(0) || key == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);

        // Revoke any prior active session for this key binding.
        uint256 prior = activeKeySession[agent][key];
        if (prior != 0 && !sessions[prior].revoked) {
            sessions[prior].revoked = true;
            emit SessionRevoked(prior, msg.sender);
        }

        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            agent: agent,
            key: key,
            expiresAt: expiresAt,
            scopesHash: scopesHash,
            revoked: false,
            exists: true
        });
        _byAgent[agent].push(sessionId);
        activeKeySession[agent][key] = sessionId;

        emit SessionIssued(sessionId, agent, key, expiresAt, scopesHash);
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

    function sessionsOf(address agent) external view returns (uint256[] memory) {
        return _byAgent[agent];
    }
}
