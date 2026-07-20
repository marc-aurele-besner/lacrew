// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {TimeWindowPolicy} from "../src/policies/TimeWindowPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {EpochStreamer} from "../src/EpochStreamer.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {MarketplacePayments} from "../src/MarketplacePayments.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule} from "../src/interfaces/IPolicyModule.sol";

/// @notice Deploys a reference org stack for Anvil / Base Sepolia scaffolding.
/// @dev Deployer key must equal HUMAN_ROOT (default) so bootstrap addNode succeeds.
///      On Anvil (31337), manager is Anvil account #1 so MANAGER_PRIVATE_KEY can sign resolve.
contract DeployMockOrg is Script {
    uint256 internal constant USDC = 1e6;
    /// @dev 20% platform take rate on marketplace sales.
    uint16 internal constant PLATFORM_FEE_BPS = 2000;
    /// @dev Anvil default account #1 — known key in lacrew/.env.example (demo only).
    address internal constant ANVIL_MANAGER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    struct Deployed {
        MockUSDC usdc;
        OrgRegistry registry;
        Treasury treasury;
        EscalationRouter router;
        GovernanceModule gov;
        SpendCapPolicy spendCap;
        PolicyStack workerStack;
        PolicyStack managerStack;
        WhitelistPolicy whitelist;
        TimeWindowPolicy timeWindow;
        EpochStreamer epochStreamer;
        SessionRegistry sessionRegistry;
        MarketplacePayments marketplace;
        address humanRoot;
        address manager;
        address worker;
        address x402Target;
    }

    function run() external {
        address humanRoot = vm.envOr("HUMAN_ROOT", msg.sender);
        uint256 fundAmount = vm.envOr("TREASURY_FUND_USDC", uint256(100_000 * USDC));
        address worker = address(uint160(uint256(keccak256("lacrew.worker"))));
        address x402Target = address(uint160(uint256(keccak256("lacrew.x402"))));
        address manager = vm.envOr(
            "MANAGER_ADDRESS",
            block.chainid == 31337
                ? ANVIL_MANAGER
                : address(uint160(uint256(keccak256("lacrew.manager"))))
        );

        vm.startBroadcast();
        Deployed memory d = _deploy(humanRoot, manager, worker, x402Target, fundAmount);
        vm.stopBroadcast();

        _writeDeployments(d);
    }

    function _deploy(
        address humanRoot,
        address manager,
        address worker,
        address x402Target,
        uint256 fundAmount
    ) private returns (Deployed memory d) {
        d.humanRoot = humanRoot;
        d.manager = manager;
        d.worker = worker;
        d.x402Target = x402Target;

        d.usdc = new MockUSDC();
        d.registry = new OrgRegistry(humanRoot);
        d.gov = new GovernanceModule(humanRoot);

        d.whitelist = new WhitelistPolicy();
        d.whitelist.setAllowed(x402Target, true);

        d.spendCap = new SpendCapPolicy(50 * USDC);
        d.spendCap.setAgentCap(manager, 200 * USDC);
        d.spendCap.setAgentCap(humanRoot, type(uint256).max);

        RateLimitPolicy rateLimit = new RateLimitPolicy(10, 1 hours);
        // Default window is the full UTC day (always ALLOW) so demos work at any hour;
        // set TIME_WINDOW_START / TIME_WINDOW_END (seconds since midnight UTC) to constrain.
        d.timeWindow = new TimeWindowPolicy(
            vm.envOr("TIME_WINDOW_START", uint256(0)),
            vm.envOr("TIME_WINDOW_END", uint256(1 days))
        );
        d.workerStack = _workerStack(d.whitelist, d.spendCap, rateLimit, d.timeWindow);
        d.managerStack = _managerStack(d.whitelist, d.spendCap);

        d.router = new EscalationRouter(address(d.registry), address(d.workerStack));
        d.treasury = new Treasury(address(d.registry), address(d.usdc), address(d.router));

        d.router.setTreasury(address(d.treasury));
        d.router.setRateRecorder(address(rateLimit));
        rateLimit.setRecorder(address(d.router));

        require(msg.sender == humanRoot, "deployer must be HUMAN_ROOT");
        d.registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, humanRoot);
        d.registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        d.router.setNodePolicy(worker, address(d.workerStack));
        d.router.setNodePolicy(manager, address(d.managerStack));

        d.usdc.mint(msg.sender, fundAmount);
        d.usdc.approve(address(d.treasury), fundAmount);
        d.treasury.deposit(fundAmount);
        d.treasury.streamAllowance(worker, 200 * USDC, 1);

        d.epochStreamer = new EpochStreamer(address(d.treasury), humanRoot);
        d.epochStreamer.setGrant(worker, 200 * USDC);
        d.treasury.setStreamer(address(d.epochStreamer));

        d.sessionRegistry = new SessionRegistry(humanRoot);
        d.router.setSessionRegistry(address(d.sessionRegistry));

        // Marketplace settlement is intentionally not wired into Treasury or the router:
        // a purchase is buyer-to-seller, not an org spend, so it must not be able to
        // reach org allowances. Fees accrue to the deployer's platform address.
        d.marketplace = new MarketplacePayments(
            address(d.usdc), vm.envOr("PLATFORM_FEE_RECIPIENT", humanRoot), humanRoot, PLATFORM_FEE_BPS
        );
        // An org buys a listing as a normal policy-checked spend: the router pays the
        // marketplace and then calls purchaseFor, so it must be both a whitelisted target
        // and the authorised settler.
        d.marketplace.setSettlementRouter(address(d.router));
        d.whitelist.setAllowed(address(d.marketplace), true);

        // Human root decides high-tier final say; manager is review-only agent seat.
        // Low-tier quorum 2 still requires root + manager dual-sign for hires.
        d.gov.setVotingPower(humanRoot, 1, GovernanceModule.SeatRole.Human);
        d.gov.setVotingPower(manager, 1, GovernanceModule.SeatRole.Agent);
        d.gov.setQuorumYes(2);
        d.gov.setQuorumHumanYes(1);

        d.registry.setGovernor(address(d.gov));
        d.treasury.setGovernor(address(d.gov));
        d.router.setGovernor(address(d.gov));
        d.epochStreamer.setGovernor(address(d.gov));
        d.whitelist.setGovernor(address(d.gov));
        d.spendCap.setGovernor(address(d.gov));
    }

    function _workerStack(
        WhitelistPolicy whitelist,
        SpendCapPolicy spendCap,
        RateLimitPolicy rateLimit,
        TimeWindowPolicy timeWindow
    ) private returns (PolicyStack) {
        IPolicyModule[] memory modules = new IPolicyModule[](4);
        modules[0] = timeWindow;
        modules[1] = whitelist;
        modules[2] = spendCap;
        modules[3] = rateLimit;
        return new PolicyStack(modules);
    }

    function _managerStack(WhitelistPolicy whitelist, SpendCapPolicy spendCap)
        private
        returns (PolicyStack)
    {
        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        return new PolicyStack(modules);
    }

    function _writeDeployments(Deployed memory d) private {
        string memory obj = "deploy";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "mockUSDC", address(d.usdc));
        vm.serializeAddress(obj, "orgRegistry", address(d.registry));
        vm.serializeAddress(obj, "treasury", address(d.treasury));
        vm.serializeAddress(obj, "escalationRouter", address(d.router));
        vm.serializeAddress(obj, "governanceModule", address(d.gov));
        vm.serializeAddress(obj, "spendCapPolicy", address(d.spendCap));
        vm.serializeAddress(obj, "policyStack", address(d.workerStack));
        vm.serializeAddress(obj, "managerPolicyStack", address(d.managerStack));
        vm.serializeAddress(obj, "whitelistPolicy", address(d.whitelist));
        vm.serializeAddress(obj, "timeWindowPolicy", address(d.timeWindow));
        vm.serializeAddress(obj, "epochStreamer", address(d.epochStreamer));
        vm.serializeAddress(obj, "sessionRegistry", address(d.sessionRegistry));
        vm.serializeAddress(obj, "marketplacePayments", address(d.marketplace));
        vm.serializeAddress(obj, "humanRoot", d.humanRoot);
        vm.serializeAddress(obj, "manager", d.manager);
        vm.serializeAddress(obj, "worker", d.worker);
        string memory json = vm.serializeAddress(obj, "x402Target", d.x402Target);

        vm.createDir("deployments", true);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));

        console2.log("EscalationRouter", address(d.router));
        console2.log("SessionRegistry", address(d.sessionRegistry));
        console2.log("MarketplacePayments", address(d.marketplace));
        console2.log("workerStack", address(d.workerStack));
        console2.log("managerStack", address(d.managerStack));
        console2.log("worker", d.worker);
        console2.log("manager", d.manager);
        console2.log("chainid", block.chainid);
    }
}
