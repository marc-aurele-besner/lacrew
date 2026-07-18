// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";
import {OrgRegistry} from "../src/OrgRegistry.sol";
import {IOrgRegistry} from "../src/interfaces/IOrgRegistry.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";

contract GovernanceFuzzTest is Test {
    address internal root = makeAddr("root");
    GovernanceModule internal gov;
    OrgRegistry internal registry;

    address internal v1 = makeAddr("v1");
    address internal v2 = makeAddr("v2");

    function setUp() public {
        registry = new OrgRegistry(root);
        gov = new GovernanceModule(root);
        vm.prank(root);
        registry.setGovernor(address(gov));
        vm.startPrank(root);
        gov.setVotingPower(v1, 1);
        gov.setVotingPower(v2, 1);
        vm.stopPrank();
        vm.warp(1_700_000_000);
    }

    function testFuzz_highTierCannotExecuteBeforeEta(uint256 earlyWarp) public {
        address worker = makeAddr("worker");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);

        vm.prank(v1);
        gov.vote(id, true);
        vm.prank(v2);
        gov.vote(id, true);

        (, , , , , , , uint256 deadline, uint256 eta, ) = gov.proposals(id);
        // Stay strictly before eta (and after some of voting period is fine).
        earlyWarp = bound(earlyWarp, 0, eta - block.timestamp - 1);
        vm.warp(block.timestamp + earlyWarp);

        vm.expectRevert(
            abi.encodeWithSelector(GovernanceModule.TimelockNotElapsed.selector, id, eta)
        );
        gov.execute(id);
        assertGt(deadline, 0);
    }

    function testFuzz_vetoBlocksExecute(uint256 warpPastEta) public {
        address worker = makeAddr("vetoed");
        bytes memory data = abi.encodeCall(
            OrgRegistry.addNode,
            (worker, IOrgRegistry.NodeKind.WorkerAgent, root)
        );
        uint256 id = gov.propose(GovernanceModule.Tier.High, address(registry), data);
        vm.prank(v1);
        gov.vote(id, true);
        vm.prank(v2);
        gov.vote(id, true);

        vm.prank(root);
        gov.veto(id);

        (, , , , , , , , uint256 eta, ) = gov.proposals(id);
        warpPastEta = bound(warpPastEta, eta, eta + 30 days);
        vm.warp(warpPastEta);

        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.ProposalNotActive.selector, id));
        gov.execute(id);
    }

    function testFuzz_sessionExpires(uint64 ttl) public {
        ttl = uint64(bound(ttl, 1, 30 days));
        SessionRegistry sessions = new SessionRegistry(root);
        address worker = makeAddr("agent");
        address key = makeAddr("key");
        uint64 exp = uint64(block.timestamp + ttl);
        vm.prank(root);
        uint256 id = sessions.issue(worker, key, exp, bytes32(0), type(uint256).max, address(0));
        assertTrue(sessions.isValid(id));

        vm.warp(uint256(exp) + 1);
        assertFalse(sessions.isValid(id));
        assertFalse(sessions.isKeyValid(worker, key));
    }
}
