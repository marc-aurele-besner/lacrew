// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";

contract SessionRegistryTest is Test {
    address internal root = makeAddr("root");
    address internal worker = makeAddr("worker");
    address internal key = makeAddr("sessionKey");
    address internal target = makeAddr("target");
    SessionRegistry internal registry;

    /// @dev Resolved in setUp: reading it inline would consume the next vm.prank.
    uint256 internal allScopes;
    function setUp() public {
        registry = new SessionRegistry(root);
        vm.warp(1_700_000_000);
        allScopes = registry.SCOPE_ALL();
    }

    function test_issueAndValidate() public {
        uint256 scopes = registry.SCOPE_SPEND_WHITELIST();
        uint256 maxValue = 200e6;
        vm.prank(root);
        uint256 id = registry.issue(
            worker, key, uint64(block.timestamp + 1 hours), scopes, maxValue, target
        );

        assertTrue(registry.isValid(id));
        assertTrue(registry.isKeyValid(worker, key));
        (
            address agent,
            address k,
            uint64 exp,
            uint256 sc,
            uint256 mv,
            address at,
            bool revoked,
            bool exists
        ) = registry.sessions(id);
        assertEq(agent, worker);
        assertEq(k, key);
        assertEq(exp, uint64(block.timestamp + 1 hours));
        assertEq(sc, scopes);
        assertEq(mv, maxValue);
        assertEq(at, target);
        assertFalse(revoked);
        assertTrue(exists);

        (bool valid, uint256 lim, address allowed, uint256 sh) = registry.keyLimits(worker, key);
        assertTrue(valid);
        assertEq(lim, maxValue);
        assertEq(allowed, target);
        assertEq(sh, scopes);
    }

    function test_expires() public {
        vm.prank(root);
        uint256 id = registry.issue(
            worker, key, uint64(block.timestamp + 10), allScopes, type(uint256).max, address(0)
        );
        vm.warp(block.timestamp + 11);
        assertFalse(registry.isValid(id));
        assertFalse(registry.isKeyValid(worker, key));
    }

    function test_rootRevokes() public {
        vm.prank(root);
        uint256 id = registry.issue(
            worker, key, uint64(block.timestamp + 1 hours), allScopes, type(uint256).max, address(0)
        );
        vm.prank(root);
        registry.revoke(id);
        assertFalse(registry.isValid(id));
    }

    function test_strangerCannotIssue() public {
        vm.expectRevert(abi.encodeWithSelector(SessionRegistry.NotAuthorized.selector, address(this)));
        registry.issue(
            worker, key, uint64(block.timestamp + 1 hours), allScopes, type(uint256).max, address(0)
        );
    }

    function test_issuerCanIssueAfterSet() public {
        address orch = makeAddr("orch");
        vm.prank(root);
        registry.setIssuer(orch);
        vm.prank(orch);
        uint256 id = registry.issue(
            worker, key, uint64(block.timestamp + 1 hours), allScopes, type(uint256).max, address(0)
        );
        assertTrue(registry.isValid(id));
    }
}
