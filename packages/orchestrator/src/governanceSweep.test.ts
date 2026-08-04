import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoExecuteEnabled, decideAutoExecute, type SweepConfig } from "./governanceSweep.js";
import type { GovernanceProposal } from "@lacrew/core";

const NOW = 1_800_000_000;

function proposal(over: Partial<GovernanceProposal> = {}): GovernanceProposal {
  return {
    id: "1",
    proposer: "0x0000000000000000000000000000000000000001",
    tier: "low",
    target: "0x0000000000000000000000000000000000000002",
    actionHash: "0x00",
    data: "0x00",
    yesVotes: 2,
    noVotes: 0,
    deadline: NOW + 3600,
    eta: 0,
    state: "active",
    ...over,
  };
}

const CONFIG: SweepConfig = {
  effectiveQuorumYes: "2",
  effectiveQuorumHumanYes: "1",
  totalHumanVotingPower: "2",
  unanimityFastPath: true,
};

describe("decideAutoExecute", () => {
  it("skips anything not active", () => {
    for (const state of ["executed", "vetoed", "defeated"] as const) {
      assert.deepEqual(decideAutoExecute(proposal({ state }), CONFIG, NOW), {
        execute: false,
        reason: "not_active",
      });
    }
  });

  it("executes a low-tier proposal at quorum", () => {
    assert.deepEqual(decideAutoExecute(proposal(), CONFIG, NOW), {
      execute: true,
      via: "quorum",
    });
  });

  it("holds a low-tier proposal below quorum", () => {
    assert.deepEqual(decideAutoExecute(proposal({ yesVotes: 1 }), CONFIG, NOW), {
      execute: false,
      reason: "quorum_not_met",
    });
  });

  it("never spends gas to finalize a defeat", () => {
    // Lapsed and losing: the contract's execute() would mark it Defeated and
    // return success — bookkeeping the sweep must not pay for.
    const p = proposal({ deadline: NOW - 10, yesVotes: 1, noVotes: 2 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), {
      execute: false,
      reason: "would_defeat",
    });
  });

  it("still executes past the deadline when the yeses hold", () => {
    const p = proposal({ deadline: NOW - 10, yesVotes: 2, noVotes: 1 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), { execute: true, via: "quorum" });
  });

  it("holds a high-tier proposal through its timelock", () => {
    const p = proposal({ tier: "high", yesHumanVotes: 1, eta: NOW + 600 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), {
      execute: false,
      reason: "timelock_pending",
    });
  });

  it("executes a high-tier proposal once the timelock elapses", () => {
    const p = proposal({ tier: "high", yesHumanVotes: 1, eta: NOW - 1 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), {
      execute: true,
      via: "timelock_elapsed",
    });
  });

  it("takes the unanimity fast path only when every seated human backs it", () => {
    const unanimous = proposal({ tier: "high", yesHumanVotes: 2, eta: NOW + 600 });
    assert.deepEqual(decideAutoExecute(unanimous, CONFIG, NOW), {
      execute: true,
      via: "unanimity",
    });
    // Fast path off → the same tally waits for the timelock.
    assert.deepEqual(decideAutoExecute(unanimous, { ...CONFIG, unanimityFastPath: false }, NOW), {
      execute: false,
      reason: "timelock_pending",
    });
  });

  it("gates high tier on the human tally, not the total", () => {
    const p = proposal({ tier: "high", yesVotes: 5, yesHumanVotes: 0, eta: NOW - 1 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), {
      execute: false,
      reason: "quorum_not_met",
    });
  });

  it("skips rather than guesses when the config or tally is unreadable", () => {
    assert.deepEqual(decideAutoExecute(proposal(), {}, NOW), {
      execute: false,
      reason: "config_unreadable",
    });
    const p = proposal({ tier: "high", yesHumanVotes: undefined, eta: NOW - 1 });
    assert.deepEqual(decideAutoExecute(p, CONFIG, NOW), {
      execute: false,
      reason: "config_unreadable",
    });
  });
});

describe("autoExecuteEnabled", () => {
  it("is opt-in and reads only the exact flag", () => {
    assert.equal(autoExecuteEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(autoExecuteEnabled({ LACREW_AUTO_EXECUTE: "1" } as NodeJS.ProcessEnv), true);
    assert.equal(autoExecuteEnabled({ LACREW_AUTO_EXECUTE: "true" } as NodeJS.ProcessEnv), false);
  });
});
