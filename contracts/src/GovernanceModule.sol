// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title GovernanceModule
/// @notice Quorum voting for constitutional actions (hire/fire, budgets, policy upgrades).
/// @dev Mocked: proposal storage + simple majority; no timelock or human veto yet.
contract GovernanceModule {
    enum Tier {
        Low,
        High
    }

    enum ProposalState {
        Active,
        Executed,
        Vetoed,
        Defeated
    }

    struct Proposal {
        address proposer;
        Tier tier;
        bytes32 actionHash;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 deadline;
        ProposalState state;
    }

    uint256 public nextProposalId = 1;
    mapping(uint256 => Proposal) public proposals;
    /// @dev Mocked: every address has voting power 1.
    /// TODO: Role-weighted voting power configured per organization.
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    uint256 public constant VOTING_PERIOD = 3 days;
    /// @dev Mocked threshold: 2 yes votes wins for scaffolding demos.
    uint256 public constant QUORUM_YES = 2;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, Tier tier);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);

    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error QuorumNotMet(uint256 proposalId);

    /// @notice Create a constitutional proposal.
    /// @dev Mocked: does not encode real actions against OrgRegistry/Treasury.
    /// TODO: Bind `actionHash` to executable calldata; High tier + timelock + human veto.
    function propose(Tier tier, bytes32 actionHash) external returns (uint256 proposalId) {
        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            tier: tier,
            actionHash: actionHash,
            yesVotes: 0,
            noVotes: 0,
            deadline: block.timestamp + VOTING_PERIOD,
            state: ProposalState.Active
        });
        emit ProposalCreated(proposalId, msg.sender, tier);
    }

    /// @notice Cast a yes/no vote.
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active || block.timestamp > p.deadline) {
            revert ProposalNotActive(proposalId);
        }
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.yesVotes += 1;
        else p.noVotes += 1;
        emit Voted(proposalId, msg.sender, support);
    }

    /// @notice Execute a proposal that has met the mocked quorum.
    /// @dev Mocked: marks Executed without applying org mutations.
    /// TODO: Apply action to OrgRegistry / Treasury / policy registry; High-tier delay.
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        if (p.yesVotes < QUORUM_YES) revert QuorumNotMet(proposalId);

        p.state = ProposalState.Executed;
        emit ProposalExecuted(proposalId);
    }
}
