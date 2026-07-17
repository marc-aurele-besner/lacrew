// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {EscalationRouter} from "../src/EscalationRouter.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";

/// @notice Deploys a mocked org stack for local / Base Sepolia scaffolding.
/// @dev Mocked: uses msg.sender as human root; no real funding.
/// TODO: Parameterize roots, caps, and token addresses for production deploys.
contract DeployMockOrg is Script {
    function run() external {
        address humanRoot = vm.envOr("HUMAN_ROOT", msg.sender);

        vm.startBroadcast();

        OrgRegistry registry = new OrgRegistry(humanRoot);
        Treasury treasury = new Treasury(address(registry));
        SpendCapPolicy policy = new SpendCapPolicy(50 ether);
        EscalationRouter router = new EscalationRouter(address(registry), address(policy));
        GovernanceModule gov = new GovernanceModule();

        // Mocked demo tree: root -> manager -> worker
        address manager = address(uint160(uint256(keccak256("lacrew.manager"))));
        address worker = address(uint160(uint256(keccak256("lacrew.worker"))));
        registry.addNode(manager, IOrgRegistry.NodeKind.ManagerAgent, humanRoot);
        registry.addNode(worker, IOrgRegistry.NodeKind.WorkerAgent, manager);
        treasury.streamAllowance(worker, 50 ether, 1);

        vm.stopBroadcast();

        console2.log("OrgRegistry", address(registry));
        console2.log("Treasury", address(treasury));
        console2.log("SpendCapPolicy", address(policy));
        console2.log("EscalationRouter", address(router));
        console2.log("GovernanceModule", address(gov));
    }
}
