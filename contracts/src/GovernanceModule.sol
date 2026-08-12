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
///
///      **Multi-human orgs.** An org may seat any number of Human seats, and the seat
///      roster itself is constitutional property: `admitHuman` / `removeHuman` (and any
///      `setVotingPower` that creates, re-weights, or revokes a Human seat) execute only
///      as governance, which `propose` forces to High tier when the target is this module.
///      A partner therefore cannot be added or fired from a private key — every change to
///      who holds final say passes the humans already seated, any one of whom can veto it.
///      The last Human seat can never be revoked: an org whose humans have all been
///      removed would leave agent seats as the only electorate, which is the one outcome
///      the tier split exists to prevent.
///
///      The root address keeps its direct admin over the non-seat parameters (quorums,
///      timing, agent seats) only while it holds a funded Human seat — or while nobody
///      does, the bootstrap of an org deployed with `rootPower_ = 0`. Governance that
///      revokes the root's seat revokes its veto and its parameter admin with it, so
///      "root" is a seat that can change hands, not a permanent key.
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
    /// @notice How many funded Human seats exist. Weight answers "how much say";
    ///         this answers "how many humans" — the number the last-human guard
    ///         and every multi-human UI are actually about.
    uint256 public humanSeatCount;
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
    event HumanAdmitted(address indexed human, uint256 power);
    event HumanRemoved(address indexed human);
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
    /// @dev Seat admin over humans is constitutional: only an executed proposal
    ///      (or the root of an org with no human seated yet) may change it.
    error NotGovernance(address caller);
    error LastHumanSeat(address human);
    error NotAHumanSeat(address account);
    error ZeroPower();
    error ActionFailed(address target);
    error ZeroAddress();
    error ZeroQuorum();
    error InvalidSeatRole(SeatRole role);
    error InvalidTiming(uint256 votingPeriod, uint256 highTierTimelock);
    error SelfTargetNotHighTier();

    /// @dev Root acts directly; the module itself qualifies so an executed High-tier
    ///      proposal targeting this contract can retune parameters through governance.
    modifier onlyRootOrGovernance() {
        if (msg.sender != address(this) && !_rootMayAct()) {
            revert NotHumanRoot(msg.sender);
        }
        _;
    }

    /// @dev The root's direct authority is the privilege of a seated human, not of an
    ///      address. It holds while the root has a funded Human seat, and — so an org
    ///      deployed with `rootPower_ = 0` is not born ungovernable — while no human is
    ///      seated at all. Once governance revokes the root's seat, the root is a
    ///      stranger to this module.
    function _rootMayAct() private view returns (bool) {
        if (msg.sender != humanRoot) return false;
        return humanSeatCount == 0 || seatRole[humanRoot] == SeatRole.Human;
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
            humanSeatCount = 1;
            emit VotingPowerUpdated(humanRoot_, rootPower_, SeatRole.Human);
        }
    }

    /// @notice Configure a seat's voting weight and role. Pass power 0 to revoke.
    /// @dev Agent seats are root-or-governance, as before. Anything that touches a
    ///      Human seat — creating one, re-weighting one, or revoking one — is seat
    ///      admin and takes the governance path (see `admitHuman`).
    function setVotingPower(address voter, uint256 power, SeatRole role) external {
        if (voter == address(0)) revert ZeroAddress();
        if (power == 0) {
            role = SeatRole.None;
        } else if (role == SeatRole.None) {
            revert InvalidSeatRole(role);
        }
        if (role == SeatRole.Human || seatRole[voter] == SeatRole.Human) {
            _authorizeSeatAdmin();
        } else if (msg.sender != address(this) && !_rootMayAct()) {
            revert NotHumanRoot(msg.sender);
        }
        _setSeat(voter, power, role);
    }

    /// @notice Seat a human (or re-weight one already seated). Governance only.
    /// @dev This is the multi-human primitive: an org admits a partner by passing a
    ///      High-tier proposal, so the humans already seated see it, can vote it down,
    ///      and can veto it. `power` is the weight the new seat votes with — it also
    ///      raises the unanimity bar, since the fast path needs every human's yes.
    function admitHuman(address human, uint256 power) external {
        if (human == address(0)) revert ZeroAddress();
        // A human seat is by definition funded: power 0 is a revocation, and
        // revocation has its own governance-checked entry point.
        if (power == 0) revert ZeroPower();
        _authorizeSeatAdmin();
        _setSeat(human, power, SeatRole.Human);
        emit HumanAdmitted(human, power);
    }

    /// @notice Revoke a human's seat — their vote and their veto. Governance only.
    /// @dev Refuses the last one. An org with no human seat has handed high-tier final
    ///      say to nobody at all (agent yes-weight never satisfies it), which would
    ///      freeze the constitution permanently rather than pass it on.
    function removeHuman(address human) external {
        if (seatRole[human] != SeatRole.Human) revert NotAHumanSeat(human);
        _authorizeSeatAdmin();
        _setSeat(human, 0, SeatRole.None);
        emit HumanRemoved(human);
    }

    /// @dev Who may change the human roster: an executed proposal, or — while the org
    ///      has no human seat to consult — the root, which is how a `rootPower_ = 0`
    ///      deployment seats its first human.
    function _authorizeSeatAdmin() private view {
        if (msg.sender == address(this)) return;
        if (humanSeatCount == 0 && msg.sender == humanRoot) return;
        revert NotGovernance(msg.sender);
    }

    /// @dev Single writer for seat state, so the weight sums and the human head count
    ///      cannot drift apart, and the last-human guard has exactly one place to sit.
    function _setSeat(address voter, uint256 power, SeatRole role) private {
        uint256 prevPower = votingPower[voter];
        SeatRole prevRole = seatRole[voter];
        if (prevRole == SeatRole.Human && role != SeatRole.Human) {
            if (humanSeatCount == 1) revert LastHumanSeat(voter);
            humanSeatCount -= 1;
        } else if (prevRole != SeatRole.Human && role == SeatRole.Human) {
            humanSeatCount += 1;
        }
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

    /// @notice Veto an active proposal before execution. Any funded Human seat may —
    ///         multi-human orgs share the safety valve, and no seat outranks another
    ///         in holding it. The root qualifies through its own seat (or, before any
    ///         human is seated, as the bootstrap holder of one).
    function veto(uint256 proposalId) external {
        bool humanSeat = votingPower[msg.sender] > 0 && seatRole[msg.sender] == SeatRole.Human;
        if (!humanSeat && !_rootMayAct()) revert NotHumanSeat(msg.sender);
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
