// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EpochStreamer} from "../src/EpochStreamer.sol";

contract EpochStreamerTest is Test {
    uint256 internal constant ONE = 1e6;

    MockUSDC internal usdc;
    Treasury internal treasury;
    EpochStreamer internal streamer;
    address internal operator = makeAddr("operator");
    address internal worker = makeAddr("worker");
    address internal manager = makeAddr("manager");

    function setUp() public {
        usdc = new MockUSDC();
        treasury = new Treasury(makeAddr("registry"), address(usdc), makeAddr("router"));
        streamer = new EpochStreamer(address(treasury), operator);

        treasury.setStreamer(address(streamer));
        // Governor not set — streamer path alone authorizes after setStreamer.

        usdc.mint(address(this), 10_000 * ONE);
        usdc.approve(address(treasury), type(uint256).max);
        treasury.deposit(5_000 * ONE);

        vm.startPrank(operator);
        streamer.setGrant(worker, 100 * ONE);
        streamer.setGrant(manager, 50 * ONE);
        vm.stopPrank();
    }

    function test_runNextEpochStreamsGrants() public {
        vm.prank(operator);
        uint64 epoch = streamer.runNextEpoch();
        assertEq(epoch, 1);
        assertEq(treasury.allowanceBalance(worker), 100 * ONE);
        assertEq(treasury.allowanceBalance(manager), 50 * ONE);
        assertEq(streamer.currentEpoch(), 1);
        assertTrue(streamer.epochCompleted(1));
    }

    function test_secondEpochAddsAgain() public {
        vm.startPrank(operator);
        streamer.runNextEpoch();
        streamer.runNextEpoch();
        vm.stopPrank();
        assertEq(treasury.allowanceBalance(worker), 200 * ONE);
        assertEq(streamer.currentEpoch(), 2);
    }

    function test_rejectsDoubleRunSameEpoch() public {
        vm.startPrank(operator);
        streamer.runEpoch(7);
        vm.expectRevert(abi.encodeWithSelector(EpochStreamer.EpochAlreadyRun.selector, uint64(7)));
        streamer.runEpoch(7);
        vm.stopPrank();
    }

    function test_rejectsStranger() public {
        vm.expectRevert(abi.encodeWithSelector(EpochStreamer.NotOperator.selector, address(this)));
        streamer.runNextEpoch();
    }

    function test_governorCanSetGrant() public {
        address gov = makeAddr("gov");
        vm.prank(operator);
        streamer.setGovernor(gov);

        address newbie = makeAddr("newbie");
        vm.prank(gov);
        streamer.setGrant(newbie, 25 * ONE);
        assertEq(streamer.grantAmount(newbie), 25 * ONE);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(EpochStreamer.NotAuthorized.selector, makeAddr("stranger")));
        streamer.setGrant(newbie, 1);
    }
}
