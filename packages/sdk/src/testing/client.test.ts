import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLacrewClient } from "./client.js";
import { MOCK_MANAGER, MOCK_ROOT, MOCK_WORKER } from "@lacrew/core";

describe("LacrewClient resolve recursion", () => {
  it("lets a manager finalize within their cap", async () => {
    const client = createLacrewClient({ useMock: true });
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target: "0x4444444444444444444444444444444444444444",
      value: 75n * 10n ** 6n,
    });
    assert.notEqual(intentId, "0");

    const result = await client.resolveIntent(intentId, true, MOCK_MANAGER);
    assert.equal(result.escalated, false);
    assert.equal(result.intent.resolved, true);
    assert.equal(result.intent.approved, true);
  });

  it("climbs to root when over manager cap", async () => {
    const client = createLacrewClient({ useMock: true });
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target: "0x4444444444444444444444444444444444444444",
      value: 250n * 10n ** 6n,
    });

    const mid = await client.resolveIntent(intentId, true, MOCK_MANAGER);
    assert.equal(mid.escalated, true);
    assert.equal(mid.intent.resolved, false);
    assert.equal(mid.intent.awaitingApprover?.toLowerCase(), MOCK_ROOT.toLowerCase());

    const top = await client.resolveIntent(intentId, true, MOCK_ROOT);
    assert.equal(top.escalated, false);
    assert.equal(top.intent.resolved, true);
    assert.equal(top.intent.approved, true);
  });

  it("runs mock governance end to end: hire → vote → execute mutates the org", async () => {
    const client = createLacrewClient({ useMock: true });
    const before = (await client.getOrgTree()).length;

    const { proposalId, account } = await client.proposeHire({ label: "Scout" });
    assert.equal((await client.getProposal(proposalId)).state, "active");

    await assert.rejects(() => client.executeGovernance(proposalId), /Quorum not met/);

    await client.voteGovernance(proposalId, true);
    const { proposal } = await client.executeGovernance(proposalId);
    assert.equal(proposal.state, "executed");

    const nodes = await client.getOrgTree();
    assert.equal(nodes.length, before + 1);
    const hired = nodes.find((n) => n.account === account);
    assert.equal(hired?.label, "Scout");
    assert.equal(hired?.active, true);
  });

  it("vetoes high-tier proposals and rejects veto on low tier", async () => {
    const client = createLacrewClient({ useMock: true });
    const low = await client.proposeHire({ label: "LowTier" });
    await assert.rejects(() => client.vetoGovernance(low.proposalId), /high-tier/);

    const high = await client.proposeSetGrant({
      account: "0x2222222222222222222222222222222222222222",
      amount: 500n * 10n ** 6n,
    });
    const { proposal } = await client.vetoGovernance(high.proposalId);
    assert.equal(proposal.state, "vetoed");
    await assert.rejects(() => client.executeGovernance(high.proposalId), /not active/);
  });

  it("fire rewires children to the fired node's parent", async () => {
    const client = createLacrewClient({ useMock: true });
    const fire = await client.proposeFire({ account: MOCK_MANAGER });
    await client.voteGovernance(fire.proposalId, true);
    await client.executeGovernance(fire.proposalId);

    const nodes = await client.getOrgTree();
    const manager = nodes.find((n) => n.account === MOCK_MANAGER);
    assert.equal(manager?.active, false);
    const worker = nodes.find((n) => n.account === MOCK_WORKER);
    assert.equal(worker?.parent?.toLowerCase(), MOCK_ROOT.toLowerCase());
  });

  it("setActive suspends and restores without rewiring children", async () => {
    const client = createLacrewClient({ useMock: true });
    const off = await client.proposeSetActive({ account: MOCK_MANAGER, active: false });
    await client.voteGovernance(off.proposalId, true);
    await client.executeGovernance(off.proposalId);

    let nodes = await client.getOrgTree();
    assert.equal(nodes.find((n) => n.account === MOCK_MANAGER)?.active, false);
    // Unlike fire (removeNode), a suspend leaves the reporting line intact.
    assert.equal(
      nodes.find((n) => n.account === MOCK_WORKER)?.parent?.toLowerCase(),
      MOCK_MANAGER.toLowerCase(),
    );

    const on = await client.proposeSetActive({ account: MOCK_MANAGER, active: true });
    await client.voteGovernance(on.proposalId, true);
    await client.executeGovernance(on.proposalId);
    nodes = await client.getOrgTree();
    assert.equal(nodes.find((n) => n.account === MOCK_MANAGER)?.active, true);
  });

  it("streams mock epochs into allowances", async () => {
    const client = createLacrewClient({ useMock: true });
    assert.equal(await client.getCurrentEpoch(), 0);
    const [allowanceBefore] = await client.getAllowances(MOCK_WORKER);

    const { epoch } = await client.runEpoch();
    assert.equal(epoch, 1);
    const [allowanceAfter] = await client.getAllowances(MOCK_WORKER);
    // The fixture worker is capped; an uncapped one would stream nothing.
    assert.notEqual(allowanceBefore!.cap, null);
    assert.equal(
      allowanceAfter!.balance,
      allowanceBefore!.balance + allowanceBefore!.cap!,
    );
    assert.equal(allowanceAfter!.epoch, 1);
  });

  it("setGrant execution updates the allowance cap", async () => {
    const client = createLacrewClient({ useMock: true });
    const grant = await client.proposeSetGrant({ account: MOCK_WORKER, amount: 999n });
    await client.voteGovernance(grant.proposalId, true);
    await client.executeGovernance(grant.proposalId);
    const [allowance] = await client.getAllowances(MOCK_WORKER);
    assert.equal(allowance!.cap, 999n);
  });
});

describe("mock electorate", () => {
  it("reports seats with weight and role", async () => {
    const client = createLacrewClient({ useMock: true });
    const seats = await client.readGovernanceSeats();
    assert.ok(seats.length > 0);
    for (const seat of seats) {
      assert.match(seat.power, /^\d+$/, "power is an integer string");
      assert.ok(["human", "agent", "none"].includes(seat.role));
    }
  });

  it("includes a human seat, since only human weight clears high tier", async () => {
    const client = createLacrewClient({ useMock: true });
    const seats = await client.readGovernanceSeats();
    assert.ok(seats.some((s) => s.role === "human"));
  });

  it("reports quorums as weights, matching the deployed defaults", async () => {
    const client = createLacrewClient({ useMock: true });
    const config = await client.readGovernanceConfig();
    assert.equal(config.quorumYes, "2");
    assert.equal(config.quorumHumanYes, "1");
    assert.ok(config.humanRoot.startsWith("0x"));
  });

  it("mock seat weights sum to at least the low-tier quorum", async () => {
    // Otherwise the fixture could never pass a proposal it is meant to demo.
    const client = createLacrewClient({ useMock: true });
    const seats = await client.readGovernanceSeats();
    const config = await client.readGovernanceConfig();
    const total = seats.reduce((sum, s) => sum + BigInt(s.power), 0n);
    assert.ok(total >= BigInt(config.quorumYes), `${total} < ${config.quorumYes}`);
  });
});
