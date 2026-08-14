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
    // Fund the worker's allowance up to the spend first: the root's approval
    // finalizes by debiting it, and an overdraft is refused like the chain's.
    await client.runEpoch();
    await client.runEpoch();
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

  it("sets many grants in one proposal (batch rescale)", async () => {
    const client = createLacrewClient({ useMock: true });
    const entries = [
      { account: MOCK_WORKER, amount: 10n * 10n ** 6n },
      { account: MOCK_MANAGER, amount: 20n * 10n ** 6n },
    ];
    const { proposalId, count } = await client.proposeSetGrants({ entries });
    assert.equal(count, 2);
    await client.voteGovernance(proposalId, true);
    const { proposal } = await client.executeGovernance(proposalId);
    assert.equal(proposal.state, "executed");

    const grants = await client.getGrants();
    const amountFor = (acct: string) =>
      grants.find((g) => g.account.toLowerCase() === acct.toLowerCase())?.amount;
    assert.equal(amountFor(MOCK_WORKER), (10n * 10n ** 6n).toString());
    assert.equal(amountFor(MOCK_MANAGER), (20n * 10n ** 6n).toString());

    await assert.rejects(() => client.proposeSetGrants({ entries: [] }), /no grants/);
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

  it("reports configured per-epoch grants as exact base-unit strings", async () => {
    const client = createLacrewClient({ useMock: true });
    const grants = await client.getGrants();
    // Every capped node is a recipient; each amount matches its cap exactly.
    const allowances = await client.getAllowances();
    const capped = allowances.filter((a) => (a.cap ?? 0n) > 0n);
    assert.equal(grants.length, capped.length);
    for (const g of grants) {
      assert.equal(typeof g.amount, "string");
      const cap = allowances.find((a) => a.node === g.account)?.cap ?? 0n;
      assert.equal(g.amount, cap.toString());
    }
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
    assert.equal(allowanceAfter!.balance, allowanceBefore!.balance + allowanceBefore!.cap!);
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

describe("mock allowance book (Treasury.spendAllowance parity)", () => {
  const target = "0x4444444444444444444444444444444444444444" as const;

  it("debits an ALLOW spend from the agent's allowance", async () => {
    const client = createLacrewClient({ useMock: true });
    const [before] = await client.getAllowances(MOCK_WORKER);
    await client.proposeIntent({ agent: MOCK_WORKER, target, value: 40n * 10n ** 6n });
    const [after] = await client.getAllowances(MOCK_WORKER);
    assert.equal(after!.balance, before!.balance - 40n * 10n ** 6n);
  });

  it("debits an approved escalation when it finalizes, not before", async () => {
    const client = createLacrewClient({ useMock: true });
    const [before] = await client.getAllowances(MOCK_WORKER);
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target,
      value: 75n * 10n ** 6n,
    });
    const [pending] = await client.getAllowances(MOCK_WORKER);
    // An escalation is a question, not a spend: nothing moves until approval.
    assert.equal(pending!.balance, before!.balance);

    await client.resolveIntent(intentId, true, MOCK_MANAGER);
    const [after] = await client.getAllowances(MOCK_WORKER);
    assert.equal(after!.balance, before!.balance - 75n * 10n ** 6n);
    const audit = await client.getAuditTrail();
    assert.ok(
      audit.some(
        (e) => e.type === "AllowanceSpent" && e.payload.value === (75n * 10n ** 6n).toString(),
      ),
      "finalize records the spend in the audit trail",
    );
  });

  it("a denial leaves the allowance untouched", async () => {
    const client = createLacrewClient({ useMock: true });
    const [before] = await client.getAllowances(MOCK_WORKER);
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target,
      value: 75n * 10n ** 6n,
    });
    await client.resolveIntent(intentId, false, MOCK_MANAGER);
    const [after] = await client.getAllowances(MOCK_WORKER);
    assert.equal(after!.balance, before!.balance);
  });

  it("refuses an overdraft finalize, keeps the intent pending, and releases it after a refill", async () => {
    const client = createLacrewClient({ useMock: true });
    // Drain the worker (fixture: 150) to 75, then escalate a 100-USDC spend.
    const first = await client.proposeIntent({ agent: MOCK_WORKER, target, value: 75n * 10n ** 6n });
    await client.resolveIntent(first.intentId, true, MOCK_MANAGER);
    const { intentId } = await client.proposeIntent({
      agent: MOCK_WORKER,
      target,
      value: 100n * 10n ** 6n,
    });

    await assert.rejects(
      () => client.resolveIntent(intentId, true, MOCK_MANAGER),
      /allowance_exceeded/,
    );
    // The refused finalize behaves like a reverted resolve: still pending.
    const stillPending = (await client.getPendingIntents()).find((i) => i.id === intentId);
    assert.ok(stillPending, "the intent survives the refused finalize");

    await client.runEpoch(); // +50 → 125, enough to cover 100
    const result = await client.resolveIntent(intentId, true, MOCK_MANAGER);
    assert.equal(result.intent.approved, true);
    const [after] = await client.getAllowances(MOCK_WORKER);
    assert.equal(after!.balance, 25n * 10n ** 6n);
  });
});

describe("mock governance vote guard", () => {
  it("refuses the seat voting twice, mirroring hasVoted", async () => {
    const client = createLacrewClient({ useMock: true });
    const { proposalId } = await client.proposeHire({ label: "Scout" });
    await client.voteGovernance(proposalId, true);
    await assert.rejects(() => client.voteGovernance(proposalId, true), /Already voted/);
    const proposal = await client.getProposal(proposalId);
    assert.equal(proposal.yesVotes, 2, "the seat's weight is counted once");
  });
});

describe("raw governance proposals", () => {
  it("joins the proposal book with a collision-free id and executes", async () => {
    const client = createLacrewClient({ useMock: true });
    const target = "0x4444444444444444444444444444444444444444" as const;
    const raw = await client.proposeGovernance({ tier: "low", target, data: "0xdeadbeef" });
    // Fetchable like any typed proposal — the old audit-length ids were not.
    const listed = await client.getProposal(raw.proposalId);
    assert.equal(listed.data, "0xdeadbeef");
    assert.equal(listed.target, target);

    const hire = await client.proposeHire({ label: "Scout" });
    assert.notEqual(hire.proposalId, raw.proposalId);

    await client.voteGovernance(raw.proposalId, true);
    const { proposal } = await client.executeGovernance(raw.proposalId);
    assert.equal(proposal.state, "executed");
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

  it("counts human heads, not only human weight", async () => {
    const client = createLacrewClient({ useMock: true });
    const config = await client.readGovernanceConfig();
    // The fixture is a solo root: one human seat carrying weight 2.
    assert.equal(config.humanSeatCount, "1");
    assert.equal(config.totalHumanVotingPower, "2");
  });
});

describe("mock seat admin (multi-human orgs)", () => {
  const partner = "0x00000000000000000000000000000000000000b0" as const;

  it("admitting a human is a high-tier proposal that moves the electorate", async () => {
    const client = createLacrewClient({ useMock: true });
    const { proposalId } = await client.proposeAdmitHuman({ account: partner, power: 2n });

    const proposal = await client.getProposal(proposalId);
    // Not a convention this method picked: the module refuses seat admin from
    // any caller but itself, and refuses a low-tier proposal aimed at itself.
    assert.equal(proposal.tier, "high");
    // Nothing changes until it executes — a staged seat is not a seated human.
    assert.equal((await client.readGovernanceConfig()).humanSeatCount, "1");

    await client.voteGovernance(proposalId, true);
    await client.executeGovernance(proposalId);

    const seats = await client.readGovernanceSeats();
    const seated = seats.find((s) => s.voter.toLowerCase() === partner);
    assert.equal(seated?.role, "human");
    assert.equal(seated?.power, "2");
    const config = await client.readGovernanceConfig();
    assert.equal(config.humanSeatCount, "2");
    assert.equal(config.totalHumanVotingPower, "4");
  });

  it("removes a human once another remains, and refuses the last one", async () => {
    const client = createLacrewClient({ useMock: true });
    const admit = await client.proposeAdmitHuman({ account: partner, power: 2n });
    await client.voteGovernance(admit.proposalId, true);
    await client.executeGovernance(admit.proposalId);

    const remove = await client.proposeRemoveHuman({ account: partner });
    await client.voteGovernance(remove.proposalId, true);
    await client.executeGovernance(remove.proposalId);
    const afterRemoval = await client.readGovernanceConfig();
    assert.equal(afterRemoval.humanSeatCount, "1");

    // The last human is not removable: an org with none has handed high-tier
    // final say to nobody, since agent weight never satisfies it.
    const last = await client.proposeRemoveHuman({
      account: afterRemoval.humanRoot,
    });
    await client.voteGovernance(last.proposalId, true);
    await assert.rejects(() => client.executeGovernance(last.proposalId), /last human seat/i);
    assert.equal((await client.readGovernanceConfig()).humanSeatCount, "1");
  });
});
