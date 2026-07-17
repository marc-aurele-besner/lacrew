// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {IPolicyModule} from "../src/interfaces/IPolicyModule.sol";

/// @notice Deploys a reference org stack for Anvil / Base Sepolia scaffolding.
/// @dev Mints MockUSDC, funds Treasury, wires router as spender.
contract DeployMockOrg is Script {
    uint256 internal constant USDC = 1e6;

    function run() external {
        address humanRoot = vm.envOr("HUMAN_ROOT", msg.sender);
        uint256 fundAmount = vm.envOr("TREASURY_FUND_USDC", uint256(100_000 * USDC));

        address manager = address(uint160(uint256(keccak256("lacrew.manager"))));
        address worker = address(uint160(uint256(keccak256("lacrew.worker"))));

        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC();
        OrgRegistry registry = new OrgRegistry(humanRoot);
        WhitelistPolicy whitelist = new WhitelistPolicy();
        whitelist.setAllowed(address(uint160(uint256(keccak256("lacrew.x402")))), true);

        SpendCapPolicy spendCap = new SpendCapPolicy(50 * USDC);
        spendCap.setAgentCap(manager, 200 * USDC);
        spendCap.setAgentCap(humanRoot, type(uint256).max);

        IPolicyModule[] memory modules = new IPolicyModule[](2);
        modules[0] = whitelist;
        modules[1] = spendCap;
        PolicyStack stack = new PolicyStack(modules);

        EscalationRouter router = new EscalationRouter(address(registry), address(stack));
        Treasury treasury = new Treasury(address(registry), address(usdc), address(router));
        GovernanceModule gov = new GovernanceModule();

        _seedOrg(registry, treasury, usdc, humanRoot, manager, worker, fundAmount);

        vm.stopBroadcast();

        _writeDeployments(usdc, registry, treasury, router, gov, spendCap, stack, whitelist);
    }

    function _seedOrg(
        OrgRegistry registry,
        Treasury treasury,
        MockUSDC usdc,
        address humanRoot,
        address manager,
        address worker,
        uint256 fundAmount
    ) private {
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, humanRoot);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);

        usdc.mint(msg.sender, fundAmount);
        usdc.approve(address(treasury), fundAmount);
        treasury.deposit(fundAmount);
        treasury.streamAllowance(worker, 50 * USDC, 1);
    }

    function _writeDeployments(
        MockUSDC usdc,
        OrgRegistry registry,
        Treasury treasury,
        EscalationRouter router,
        GovernanceModule gov,
        SpendCapPolicy spendCap,
        PolicyStack stack,
        WhitelistPolicy whitelist
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
        console2.log("chainid", block.chainid);
    }
}
