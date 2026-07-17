// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";

contract SessionRegistryTest is Test {
    address internal root = makeAddr("root");
    address internal worker = makeAddr("worker");
    address internal key = makeAddr("sessionKey");
    SessionRegistry internal registry;

    function setUp() public {
        registry = new SessionRegistry(root);
        vm.warp(1_700_000_000);
    }

    function test_issueAndValidate() public {
        bytes32 scopes = keccak256("spend:whitelist");
        vm.prank(root);
        uint256 id = registry.issue(worker, key, uint64(block.timestamp + 1 hours), scopes);

        assertTrue(registry.isValid(id));
        assertTrue(registry.isKeyValid(worker, key));
        (address agent, address k, uint64 exp, bytes32 sc, bool revoked, bool exists) = registry
            .sessions(id);
        assertEq(agent, worker);
        assertEq(k, key);
        assertEq(exp, uint64(block.timestamp + 1 hours));
        assertEq(sc, scopes);
        assertFalse(revoked);
        assertTrue(exists);
    }

    function test_expires() public {
        vm.prank(root);
        uint256 id = registry.issue(worker, key, uint64(block.timestamp + 10), bytes32(0));
        vm.warp(block.timestamp + 11);
        assertFalse(registry.isValid(id));
        assertFalse(registry.isKeyValid(worker, key));
    }

    function test_rootRevokes() public {
        vm.prank(root);
        uint256 id = registry.issue(worker, key, uint64(block.timestamp + 1 hours), bytes32(0));
        vm.prank(root);
        registry.revoke(id);
        assertFalse(registry.isValid(id));
    }

    function test_strangerCannotIssue() public {
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.NotAuthorized.selector, address(this)));
        registry.issue(worker, key, uint64(block.timestamp + 1 hours), bytes32(0));
    }

    function test_issuerCanIssueAfterSet() public {
        address orch = makeAddr("orch");
        vm.prank(root);
        registry.setIssuer(orch);
        vm.prank(orch);
        uint256 id = registry.issue(worker, key, uint64(block.timestamp + 1 hours), bytes32(0));
        assertTrue(registry.isValid(id));
    }
}
