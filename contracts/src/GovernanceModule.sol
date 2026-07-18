// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title GovernanceModule
/// @notice Quorum voting for constitutional actions (hire/fire, budgets, policy upgrades).
/// @dev Low tier: execute after all-seat quorum. High tier: human-seat quorum + timelock;
///      agent seats may vote as review authority but do not satisfy high-tier final say.
///      Human root may veto high-tier proposals. Voting power is role-weighted per seat.
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

    /// @notice Seat classification. Agents review; humans decide high-tier final say.
    enum SeatRole {
        None,
        Human,
        Agent
    }

    struct Proposal {
        address proposer;
        Tier tier;
        address target;
        bytes32 actionHash;
        bytes data;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 yesHumanVotes;
        uint256 deadline;
        uint256 eta;
        ProposalState state;
    }

    address public immutable humanRoot;

    uint256 public nextProposalId = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @notice Role-weighted seat power. Zero means the address cannot vote.
    mapping(address => uint256) public votingPower;
    /// @notice Human vs agent seat. Agent yes-weight counts for low tier only.
    mapping(address => SeatRole) public seatRole;
    /// @notice Yes-weight required to execute low-tier proposals (all seats).
    uint256 public quorumYes = 2;
    /// @notice Human yes-weight required to execute high-tier proposals.
    uint256 public quorumHumanYes = 1;

    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant HIGH_TIER_TIMELOCK = 1 days;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        Tier tier,
        address target,
        bytes32 actionHash
    );
    event Voted(
        uint256 indexed proposalId, address indexed voter, bool support, uint256 weight
    );
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer);
    event ProposalDefeated(uint256 indexed proposalId);
    event VotingPowerUpdated(address indexed voter, uint256 power, SeatRole role);
    event QuorumYesUpdated(uint256 quorumYes);
    event QuorumHumanYesUpdated(uint256 quorumHumanYes);

    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error NoVotingPower(address voter);
    error QuorumNotMet(uint256 proposalId);
    error TimelockNotElapsed(uint256 proposalId, uint256 eta);
    error NotHumanRoot(address caller);
    error ActionFailed(address target);
    error ZeroAddress();
    error ZeroQuorum();
    error InvalidSeatRole(SeatRole role);

    constructor(address humanRoot_) {
        if (humanRoot_ == address(0)) revert ZeroAddress();
        humanRoot = humanRoot_;
    }

    /// @notice Configure a seat's voting weight and role. Pass power 0 to revoke.
    function setVotingPower(address voter, uint256 power, SeatRole role) external {
        if (msg.sender != humanRoot) revert NotHumanRoot(msg.sender);
        if (voter == address(0)) revert ZeroAddress();
        if (power == 0) {
            role = SeatRole.None;
        } else if (role == SeatRole.None) {
            revert InvalidSeatRole(role);
        }
        votingPower[voter] = power;
        seatRole[voter] = role;
        emit VotingPowerUpdated(voter, power, role);
    }

    /// @notice Update the all-seat yes quorum (low tier).
    function setQuorumYes(uint256 quorumYes_) external {
        if (msg.sender != humanRoot) revert NotHumanRoot(msg.sender);
        if (quorumYes_ == 0) revert ZeroQuorum();
        quorumYes = quorumYes_;
        emit QuorumYesUpdated(quorumYes_);
    }

    /// @notice Update the human-seat yes quorum (high tier final say).
    function setQuorumHumanYes(uint256 quorumHumanYes_) external {
        if (msg.sender != humanRoot) revert NotHumanRoot(msg.sender);
        if (quorumHumanYes_ == 0) revert ZeroQuorum();
        quorumHumanYes = quorumHumanYes_;
        emit QuorumHumanYesUpdated(quorumHumanYes_);
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
            yesHumanVotes: 0,
            deadline: deadline,
            eta: tier == Tier.High ? deadline + HIGH_TIER_TIMELOCK : 0,
            state: ProposalState.Active
        });
        emit ProposalCreated(proposalId, msg.sender, tier, target, actionHash);
    }

    /// @notice Cast a yes/no vote weighted by the caller's seat.
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active || block.timestamp > p.deadline) {
            revert ProposalNotActive(proposalId);
        }
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        uint256 weight = votingPower[msg.sender];
        if (weight == 0) revert NoVotingPower(msg.sender);

        hasVoted[proposalId][msg.sender] = true;
        if (support) {
            p.yesVotes += weight;
            if (seatRole[msg.sender] == SeatRole.Human) {
                p.yesHumanVotes += weight;
            }
        } else {
            p.noVotes += weight;
        }
        emit Voted(proposalId, msg.sender, support, weight);
    }

    /// @notice Human root veto for high-tier proposals before execution.
    function veto(uint256 proposalId) external {
        if (msg.sender != humanRoot) revert NotHumanRoot(msg.sender);
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        p.state = ProposalState.Vetoed;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    /// @notice Execute a proposal that has met the tier's quorum (and high-tier timelock).
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);

        if (p.tier == Tier.High) {
            if (p.yesHumanVotes < quorumHumanYes) revert QuorumNotMet(proposalId);
            if (block.timestamp < p.eta) revert TimelockNotElapsed(proposalId, p.eta);
        } else if (p.yesVotes < quorumYes) {
            revert QuorumNotMet(proposalId);
        }

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
