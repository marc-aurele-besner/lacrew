// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {RateLimitPolicy} from "../src/policies/RateLimitPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule} from "../src/interfaces/IPolicyModule.sol";

/// @notice Deploys a reference org stack for Anvil / Base Sepolia scaffolding.
/// @dev Deployer key must equal HUMAN_ROOT (default) so bootstrap addNode succeeds.
///      On Anvil (31337), manager is Anvil account #1 so MANAGER_PRIVATE_KEY can sign resolve.
contract DeployMockOrg is Script {
    uint256 internal constant USDC = 1e6;
    /// @dev Anvil default account #1 — known key in lacrew/.env.example (demo only).
    address internal constant ANVIL_MANAGER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

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

        MockUSDC usdc = new MockUSDC();
        OrgRegistry registry = new OrgRegistry(humanRoot);
        GovernanceModule gov = new GovernanceModule(humanRoot);

        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(x402Target, true);

        SpendCapPolicy spendCap = new SpendCapPolicy(50 * USDC);
        spendCap.setAgentCap(manager, 200 * USDC);
        spendCap.setAgentCap(humanRoot, type(uint256).max);

        RateLimitPolicy rateLimit = new RateLimitPolicy(10, 1 hours);

        IPolicyModule[] memory modules = new IPolicyModule[](3);
        modules[0] = whitelist;
        modules[1] = spendCap;
        modules[2] = rateLimit;
        PolicyStack stack = new PolicyStack(modules);

        EscalationRouter router = new EscalationRouter(address(registry), address(stack));
        Treasury treasury = new Treasury(address(registry), address(usdc), address(router));

        router.setTreasury(address(treasury));
        router.setRateRecorder(address(rateLimit));
        rateLimit.setRecorder(address(router));

        require(msg.sender == humanRoot, "deployer must be HUMAN_ROOT");
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, humanRoot);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        usdc.mint(msg.sender, fundAmount);
        usdc.approve(address(treasury), fundAmount);
        treasury.deposit(fundAmount);
        // Stream enough for manager-approved overages (policy cap stays 50; balance can be higher).
        treasury.streamAllowance(worker, 200 * USDC, 1);

        registry.setGovernor(address(gov));
        treasury.setGovernor(address(gov));

        vm.stopBroadcast();

        _writeDeployments(
            usdc,
            registry,
            treasury,
            router,
            gov,
            spendCap,
            stack,
            whitelist,
            humanRoot,
            manager,
            worker,
            x402Target
        );
    }

    function _writeDeployments(
        MockUSDC usdc,
        OrgRegistry registry,
        Treasury treasury,
        EscalationRouter router,
        GovernanceModule gov,
        SpendCapPolicy spendCap,
        PolicyStack stack,
        WhitelistPolicy whitelist,
        address humanRoot,
        address manager,
        address worker,
        address x402Target
    ) private {
        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "mockUSDC": "',
            vm.toString(address(usdc)),
            '",\n',
            '  "orgRegistry": "',
            vm.toString(address(registry)),
            '",\n',
            '  "treasury": "',
            vm.toString(address(treasury)),
            '",\n',
            '  "escalationRouter": "',
            vm.toString(address(router)),
            '",\n',
            '  "governanceModule": "',
            vm.toString(address(gov)),
            '",\n',
            '  "spendCapPolicy": "',
            vm.toString(address(spendCap)),
            '",\n',
            '  "policyStack": "',
            vm.toString(address(stack)),
            '",\n',
            '  "whitelistPolicy": "',
            vm.toString(address(whitelist)),
            '",\n',
            '  "humanRoot": "',
            vm.toString(humanRoot),
            '",\n',
            '  "manager": "',
            vm.toString(manager),
            '",\n',
            '  "worker": "',
            vm.toString(worker),
            '",\n',
            '  "x402Target": "',
            vm.toString(x402Target),
            '"\n',
            "}\n"
        );
        vm.createDir("deployments", true);
        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), json);

        console2.log("MockUSDC", address(usdc));
        console2.log("OrgRegistry", address(registry));
        console2.log("Treasury", address(treasury));
        console2.log("EscalationRouter", address(router));
        console2.log("GovernanceModule", address(gov));
        console2.log("humanRoot", humanRoot);
        console2.log("manager", manager);
        console2.log("worker", worker);
        console2.log("x402Target", x402Target);
        console2.log("chainid", block.chainid);
    }
}
