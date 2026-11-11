/**
 * The drift guard on the suite itself.
 *
 * A contract that gains a function or an error the scenarios never touch would
 * otherwise go unsimulated in silence. Here it fails: everything in the
 * simulated contracts' ABIs is either exercised by a scenario or listed in
 * `NOT_SIMULATED` with a reason.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { SandboxNeedsChainError, createSandboxClient, manualClock } from "@lacrew/sdk/sandbox";

import { abiSurface } from "./abiSurface.js";
import { NOT_SIMULATED, NOT_SIMULATED_CONTRACTS, exercised } from "./coverage.js";
import { ABIS, ACTORS } from "./refs.js";
import { SCENARIOS } from "./scenarios/index.js";

describe("conformance coverage of the contract ABIs", () => {
  const surface = abiSurface();
  const covered = exercised(SCENARIOS);

  it("expects only functions and errors the ABIs declare", () => {
    assert.deepEqual(covered.problems, []);
  });

  it("exercises or accounts for every state-changing function", () => {
    const missing = surface.functions.filter(
      (name) => !covered.functions.has(name) && !(name in NOT_SIMULATED),
    );
    assert.deepEqual(missing, [], "no scenario calls these, and NOT_SIMULATED does not list them");
  });

  it("exercises or accounts for every custom error", () => {
    const missing = surface.errors.filter(
      (name) => !covered.errors.has(name) && !(name in NOT_SIMULATED),
    );
    assert.deepEqual(
      missing,
      [],
      "no scenario expects these, and NOT_SIMULATED does not list them",
    );
  });

  it("keeps NOT_SIMULATED to real, reasoned, unexercised entries", () => {
    const known = new Set([...surface.functions, ...surface.errors]);
    for (const [name, reason] of Object.entries(NOT_SIMULATED)) {
      assert.ok(known.has(name), `${name} is not in any simulated contract's ABI`);
      assert.ok(reason.trim().length > 20, `${name} needs a reason`);
      assert.equal(
        covered.functions.has(name) || covered.errors.has(name),
        false,
        `${name} is exercised by a scenario; drop it from NOT_SIMULATED`,
      );
    }
    for (const [contract, reason] of Object.entries(NOT_SIMULATED_CONTRACTS)) {
      assert.equal(contract in ABIS, false, `${contract} is simulated; drop it from the list`);
      assert.ok(reason.trim().length > 20, `${contract} needs a reason`);
    }
  });

  it("refuses the functions it does not simulate instead of answering them", () => {
    const client = createSandboxClient({ root: ACTORS.root, clock: manualClock(1_700_000_000) });
    const token = client.addresses.mockUSDC!;
    const calls = [
      encodeFunctionData({ abi: ABIS.MockUSDC, functionName: "faucet" }),
      encodeFunctionData({
        abi: ABIS.MockUSDC,
        functionName: "cancelAuthorization",
        args: [ACTORS.root, `0x${"00".repeat(32)}`, "0x"],
      }),
      encodeFunctionData({
        abi: ABIS.MockUSDC,
        functionName: "transferWithAuthorization",
        args: [ACTORS.root, ACTORS.target, 1n, 0n, 2n ** 64n, `0x${"00".repeat(32)}`, "0x"],
      }),
    ];
    for (const data of calls) {
      assert.throws(() => client.sendTransaction({ to: token, data }), SandboxNeedsChainError);
    }
  });
});
