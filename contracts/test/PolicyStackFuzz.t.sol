// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPolicyModule, Verdict} from "../src/interfaces/IPolicyModule.sol";
import {PolicyStack} from "../src/policies/PolicyStack.sol";
import {SpendCapPolicy} from "../src/policies/SpendCapPolicy.sol";
import {WhitelistPolicy} from "../src/policies/WhitelistPolicy.sol";

contract FixedVerdictPolicy is IPolicyModule {
    Verdict public immutable fixedVerdict;

    constructor(Verdict v) {
        fixedVerdict = v;
    }

    function check(address, address, uint256, bytes calldata) external view returns (Verdict) {
        return fixedVerdict;
    }
}

contract PolicyStackFuzzTest is Test {
    function testFuzz_firstDenyWins(uint8 a, uint8 b, uint8 c) public {
        Verdict va = Verdict(uint8(bound(a, 0, 2)));
        Verdict vb = Verdict(uint8(bound(b, 0, 2)));
        Verdict vc = Verdict(uint8(bound(c, 0, 2)));

        IPolicyModule[] memory modules = new IPolicyModule[](3);
        modules[0] = new FixedVerdictPolicy(va);
        modules[1] = new FixedVerdictPolicy(vb);
        modules[2] = new FixedVerdictPolicy(vc);
        PolicyStack stack = new PolicyStack(modules);

        Verdict got = stack.check(address(1), address(2), 1, "");

        if (va == Verdict.DENY || vb == Verdict.DENY || vc == Verdict.DENY) {
            assertEq(uint8(got), uint8(Verdict.DENY));
        } else if (va == Verdict.ESCALATE || vb == Verdict.ESCALATE || vc == Verdict.ESCALATE) {
            assertEq(uint8(got), uint8(Verdict.ESCALATE));
        } else {
            assertEq(uint8(got), uint8(Verdict.ALLOW));
        }
    }

    function testFuzz_spendCapAllowOrEscalate(uint256 value, uint256 cap) public {
        cap = bound(cap, 1, type(uint128).max);
        value = bound(value, 0, type(uint128).max);
        SpendCapPolicy policy = new SpendCapPolicy(cap);
        Verdict v = policy.check(address(this), address(1), value, "");
        if (value <= cap) assertEq(uint8(v), uint8(Verdict.ALLOW));
        else assertEq(uint8(v), uint8(Verdict.ESCALATE));
    }

    function testFuzz_whitelistDeniesUnknown(address target, bool allowed) public {
        vm.assume(target != address(0));
        WhitelistPolicy policy = new WhitelistPolicy();
        if (allowed) policy.setAllowed(target, true);
        Verdict v = policy.check(address(this), target, 1, "");
        if (allowed) assertEq(uint8(v), uint8(Verdict.ALLOW));
        else assertEq(uint8(v), uint8(Verdict.DENY));
    }
}
