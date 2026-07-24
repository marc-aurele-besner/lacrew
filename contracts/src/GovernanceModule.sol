// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title GovernanceModule
/// @notice Quorum voting for constitutional actions (hire/fire, budgets, policy upgrades).
/// @dev Low tier: execute after all-seat quorum. High tier: human-seat quorum + timelock;
///      agent seats may vote as review authority but do not satisfy high-tier final say.
///      Any funded Human seat (root included) may veto before execution — the human
///      safety valve is shared, never delegated to agents. Power is role-weighted per seat.
///
///      Bootstrap-safe by construction: the effective quorum never exceeds the weight the
///      seated electorate can actually deliver, so a solo human root is never deadlocked
///      behind a quorum sized for seats that do not exist yet. And when every human seat
///      has voted yes, the high-tier timelock is skippable (`unanimityFastPath`) — the
///      delay protects humans who have not weighed in, and there are none left.
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
    /// @notice Sum of all seat weight. Caps the effective low-tier quorum.
    uint256 public totalVotingPower;
    /// @notice Sum of human-seat weight. Caps the effective high-tier quorum and
    ///         defines unanimity for the timelock fast path.
    uint256 public totalHumanVotingPower;
    /// @notice Yes-weight required to execute low-tier proposals (all seats).
    uint256 public quorumYes = 2;
    /// @notice Human yes-weight required to execute high-tier proposals.
    uint256 public quorumHumanYes = 1;

    /// @notice Voting window applied to proposals at creation time.
    uint256 public votingPeriod = 3 days;
    /// @notice Delay after the voting deadline before high-tier execution. May be zero.
    uint256 public highTierTimelock = 1 days;
    /// @notice When true, a high-tier proposal backed by ALL human voting weight
    ///         executes without waiting for the timelock.
    bool public unanimityFastPath = true;

    uint256 public constant MIN_VOTING_PERIOD = 1 hours;
    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MAX_TIMELOCK = 30 days;

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
    event TimingUpdated(uint256 votingPeriod, uint256 highTierTimelock);
    event UnanimityFastPathUpdated(bool enabled);

    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error NoVotingPower(address voter);
    error QuorumNotMet(uint256 proposalId);
    error TimelockNotElapsed(uint256 proposalId, uint256 eta);
    error NotHumanRoot(address caller);
    error NotHumanSeat(address caller);
    error ActionFailed(address target);
    error ZeroAddress();
    error ZeroQuorum();
    error InvalidSeatRole(SeatRole role);
    error InvalidTiming(uint256 votingPeriod, uint256 highTierTimelock);
    error SelfTargetNotHighTier();

    /// @dev Root acts directly; the module itself qualifies so an executed High-tier
    ///      proposal targeting this contract can retune parameters through governance.
    modifier onlyRootOrGovernance() {
        if (msg.sender != humanRoot && msg.sender != address(this)) {
            revert NotHumanRoot(msg.sender);
        }
        _;
    }

    /// @param humanRoot_ The org's root human; sole direct admin of seats and params.
    /// @param rootPower_ Voting weight seeded for the root at deploy. Non-zero keeps a
    ///        fresh org governable by its only human from block one; pass a weight above
    ///        the default agent weight (e.g. 2) so humans outweigh agent seats. Zero
    ///        skips seeding for orgs that configure seats explicitly.
    constructor(address humanRoot_, uint256 rootPower_) {
        if (humanRoot_ == address(0)) revert ZeroAddress();
        humanRoot = humanRoot_;
        if (rootPower_ > 0) {
            votingPower[humanRoot_] = rootPower_;
            seatRole[humanRoot_] = SeatRole.Human;
            totalVotingPower = rootPower_;
            totalHumanVotingPower = rootPower_;
            emit VotingPowerUpdated(humanRoot_, rootPower_, SeatRole.Human);
        }
    }

    /// @notice Configure a seat's voting weight and role. Pass power 0 to revoke.
    function setVotingPower(address voter, uint256 power, SeatRole role)
        external
        onlyRootOrGovernance
    {
        if (voter == address(0)) revert ZeroAddress();
        if (power == 0) {
            role = SeatRole.None;
        } else if (role == SeatRole.None) {
            revert InvalidSeatRole(role);
        }
        uint256 prevPower = votingPower[voter];
        SeatRole prevRole = seatRole[voter];
        totalVotingPower = totalVotingPower - prevPower + power;
        if (prevRole == SeatRole.Human) totalHumanVotingPower -= prevPower;
        if (role == SeatRole.Human) totalHumanVotingPower += power;
        votingPower[voter] = power;
        seatRole[voter] = role;
        emit VotingPowerUpdated(voter, power, role);
    }

    /// @notice Update the all-seat yes quorum (low tier).
    function setQuorumYes(uint256 quorumYes_) external onlyRootOrGovernance {
        if (quorumYes_ == 0) revert ZeroQuorum();
        quorumYes = quorumYes_;
        emit QuorumYesUpdated(quorumYes_);
    }

    /// @notice Update the human-seat yes quorum (high tier final say).
    function setQuorumHumanYes(uint256 quorumHumanYes_) external onlyRootOrGovernance {
        if (quorumHumanYes_ == 0) revert ZeroQuorum();
        quorumHumanYes = quorumHumanYes_;
        emit QuorumHumanYesUpdated(quorumHumanYes_);
    }

    /// @notice Update the voting window and high-tier timelock for future proposals.
    ///         Existing proposals keep the deadline/eta captured at creation.
    function setTiming(uint256 votingPeriod_, uint256 highTierTimelock_)
        external
        onlyRootOrGovernance
    {
        if (
            votingPeriod_ < MIN_VOTING_PERIOD || votingPeriod_ > MAX_VOTING_PERIOD
                || highTierTimelock_ > MAX_TIMELOCK
        ) {
            revert InvalidTiming(votingPeriod_, highTierTimelock_);
        }
        votingPeriod = votingPeriod_;
        highTierTimelock = highTierTimelock_;
        emit TimingUpdated(votingPeriod_, highTierTimelock_);
    }

    /// @notice Enable or disable immediate execution on unanimous human yes.
    function setUnanimityFastPath(bool enabled) external onlyRootOrGovernance {
        unanimityFastPath = enabled;
        emit UnanimityFastPathUpdated(enabled);
    }

    /// @notice Low-tier quorum actually enforced: never more yes-weight than the
    ///         seated electorate holds, so quorum cannot demand absent voters.
    function effectiveQuorumYes() public view returns (uint256) {
        uint256 available = totalVotingPower;
        if (available > 0 && available < quorumYes) return available;
        return quorumYes;
    }

    /// @notice High-tier human quorum actually enforced, capped at seated human weight.
    function effectiveQuorumHumanYes() public view returns (uint256) {
        uint256 available = totalHumanVotingPower;
        if (available > 0 && available < quorumHumanYes) return available;
        return quorumHumanYes;
    }

    /// @notice Create a constitutional proposal bound to executable calldata.
    ///         Proposals targeting this module (parameter changes) must be High tier
    ///         so agent seats can never re-weight the electorate via a low-tier vote.
    function propose(
        Tier tier,
        address target,
        bytes calldata data
    ) external returns (uint256 proposalId) {
        if (target == address(0)) revert ZeroAddress();
        if (target == address(this) && tier != Tier.High) revert SelfTargetNotHighTier();
        proposalId = nextProposalId++;
        bytes32 actionHash = keccak256(abi.encode(target, data));
        uint256 deadline = block.timestamp + votingPeriod;
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
            eta: tier == Tier.High ? deadline + highTierTimelock : 0,
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

    /// @notice Veto an active proposal before execution. Root always may; so may
    ///         any funded Human seat — multi-human orgs share the safety valve.
    function veto(uint256 proposalId) external {
        bool humanSeat = votingPower[msg.sender] > 0 && seatRole[msg.sender] == SeatRole.Human;
        if (msg.sender != humanRoot && !humanSeat) revert NotHumanSeat(msg.sender);
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        p.state = ProposalState.Vetoed;
        emit ProposalVetoed(proposalId, msg.sender);
    }

    /// @notice Execute a proposal that has met the tier's effective quorum (and, for
    ///         high tier, the timelock — unless every human seat has already voted yes).
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != ProposalState.Active) revert ProposalNotActive(proposalId);

        if (p.tier == Tier.High) {
            if (p.yesHumanVotes < effectiveQuorumHumanYes()) revert QuorumNotMet(proposalId);
            if (block.timestamp < p.eta && !_unanimousHumanYes(p)) {
                revert TimelockNotElapsed(proposalId, p.eta);
            }
        } else if (p.yesVotes < effectiveQuorumYes()) {
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

    /// @dev The timelock shields humans who have not voted; unanimity means none remain.
    ///      Any human no-vote (or weight granted after the yes votes) breaks unanimity,
    ///      so the fast path only fires when every seated human backs the action now.
    function _unanimousHumanYes(Proposal storage p) private view returns (bool) {
        return unanimityFastPath && totalHumanVotingPower > 0
            && p.yesHumanVotes >= totalHumanVotingPower;
    }
}
