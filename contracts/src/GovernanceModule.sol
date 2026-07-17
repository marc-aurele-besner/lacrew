// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title GovernanceModule
/// @notice Quorum voting for constitutional actions (hire/fire, budgets, policy upgrades).
/// @dev Low tier: execute after quorum. High tier: quorum + timelock; human root may veto.
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
        address target;
        bytes32 actionHash;
        bytes data;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 deadline;
        uint256 eta;
        ProposalState state;
    }

    address public immutable humanRoot;

    uint256 public nextProposalId = 1;
    mapping(uint256 => Proposal) public proposals;
    /// @dev Mocked: every address has voting power 1.
    /// TODO: Role-weighted voting power configured per organization.
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant HIGH_TIER_TIMELOCK = 1 days;
    /// @dev Mocked threshold: 2 yes votes wins for scaffolding demos.
    uint256 public constant QUORUM_YES = 2;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        Tier tier,
        address target,
        bytes32 actionHash
    );
    event Voted(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer);
    event ProposalDefeated(uint256 indexed proposalId);

    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error QuorumNotMet(uint256 proposalId);
    error TimelockNotElapsed(uint256 proposalId, uint256 eta);
    error NotHumanRoot(address caller);
    error ActionFailed(address target);
    error ZeroAddress();

    constructor(address humanRoot_) {
        if (humanRoot_ == address(0)) revert ZeroAddress();
        humanRoot = humanRoot_;
    }

    /// @notice Create a constitutional proposal bound to executable calldata.
    function propose(
        Tier tier,
        address target,
        bytes calldata data
    ) external returns (uint256 proposalId) {
        if (target == address(0)) revert ZeroAddress();
        proposalId = nextProposalId++;
        bytes32 actionHash = keccak256(abi.encode(target, data));
        uint256 deadline = block.timestamp + VOTING_PERIOD;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            tier: tier,
            target: target,
            actionHash: actionHash,
            data: data,
            yesVotes: 0,
            noVotes: 0,
            deadline: deadline,
            eta: tier == Tier.High ? deadline + HIGH_TIER_TIMELOCK : 0,
            state: ProposalState.Active
        });
        emit ProposalCreated(proposalId, msg.sender, tier, target, actionHash);
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

    /// @notice Human root veto for high-tier proposals before execution.
    function veto(uint256 proposalId) external {
        if (msg.sender != humanRoot) revert NotHumanRoot(msg.sender);
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        p.state = ProposalState.Vetoed;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    /// @notice Execute a proposal that has met quorum (and high-tier timelock).
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        if (p.yesVotes < QUORUM_YES) revert QuorumNotMet(proposalId);

        if (p.tier == Tier.High) {
            if (block.timestamp < p.eta) revert TimelockNotElapsed(proposalId, p.eta);
        }

        // Past voting deadline with insufficient yes already blocked by quorum check;
        // mark defeated if more no than yes after deadline (optional hygiene).
        if (block.timestamp > p.deadline && p.noVotes > p.yesVotes) {
            p.state = ProposalState.Defeated;
            emit ProposalDefeated(proposalId);
            return;
        }

        p.state = ProposalState.Executed;
        (bool ok, ) = p.target.call(p.data);
        if (!ok) revert ActionFailed(p.target);
        emit ProposalExecuted(proposalId);
    }
}
