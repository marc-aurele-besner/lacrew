// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GovernanceModule} from "../src/GovernanceModule.sol";

contract GovernanceModuleTest is Test {
    GovernanceModule internal gov;

    function setUp() public {
        gov = new GovernanceModule();
    }

    function test_proposeVoteAndExecute() public {
        uint256 id = gov.propose(GovernanceModule.Tier.Low, keccak256("hire-worker"));

        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);
        vm.prank(makeAddr("voter2"));
        gov.vote(id, true);

        gov.execute(id);

        (
            ,
            ,
            ,
            uint256 yesVotes,
            ,
            ,
            GovernanceModule.ProposalState state
        ) = gov.proposals(id);

        assertEq(yesVotes, 2);
        assertEq(uint8(state), uint8(GovernanceModule.ProposalState.Executed));
    }

    function test_executeRequiresQuorum() public {
        uint256 id = gov.propose(GovernanceModule.Tier.High, keccak256("raise-budget"));
        vm.prank(makeAddr("voter1"));
        gov.vote(id, true);

        vm.expectRevert(abi.encodeWithSelector(GovernanceModule.QuorumNotMet.selector, id));
        gov.execute(id);
    }
}
