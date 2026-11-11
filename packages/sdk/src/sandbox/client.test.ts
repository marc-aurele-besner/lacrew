import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import {
  escalationRouterAbi,
  governanceModuleAbi,
  mockUsdcAbi,
  orgRegistryAbi,
  sessionScopeMask,
  treasuryAbi,
} from "@lacrew/core";

import { policyDenialOf } from "../policyDenial.js";
import type { ProtocolClient } from "../protocolClient.js";
import {
  SandboxNeedsChainError,
  SimRevert,
  createSandboxClient,
  manualClock,
  type SandboxCommit,
  type SandboxLacrewClient,
} from "./index.js";

type Address = `0x${string}`;
const named = (byte: string): Address => `0x${byte.repeat(20)}` as Address;

const ROOT = named("a1");
const MANAGER = named("b2");
const WORKER = named("c3");
const STRANGER = named("d4");
const TARGET = named("e5");
const KEY = named("f7");
const T0 = 1_700_000_000;
const USDC = 1_000_000n;
const DAY = 86_400;

function sandbox(commits: SandboxCommit[] = []) {
  const clock = manualClock(T0);
  const client = createSandboxClient({
    root: ROOT,
    clock,
    onCommit: (commit) => commits.push(commit),
  });
  return { client, clock, commits };
}

const revertsWith = (errorName: string) => (err: unknown) =>
  err instanceof SimRevert && err.errorName === errorName;

/** Propose, vote yes as the root and execute: a solo root clears either tier at once. */
async function pass(
  client: SandboxLacrewClient,
  propose: Promise<{ proposalId: string }>,
): Promise<string> {
  const { proposalId } = await propose;
  await client.voteGovernance(proposalId, true);
  await client.executeGovernance(proposalId);
  return proposalId;
}

/** The reference crew, built the only way a bound org allows: through governance. */
async function crew(client: SandboxLacrewClient): Promise<void> {
  await pass(
    client,
    client.proposeHire({ label: "manager", kind: "manager_agent", account: MANAGER }),
  );
  await pass(client, client.proposeHire({ label: "worker", account: WORKER, parent: MANAGER }));
  await pass(client, client.proposeSetWhitelist({ target: TARGET, allowed: true }));
  await pass(client, client.proposeSetGrant({ account: WORKER, amount: 200n * USDC }));
  await client.fund(10_000n * USDC);
  await client.runEpoch();
}

describe("sandbox client: genesis", () => {
  it("is a ProtocolClient on the sandbox ledger with no chain id", () => {
    const { client } = sandbox();
    const typed: ProtocolClient = client;
    assert.equal(typed.ledger, "sandbox");
    assert.equal(client.addresses.chainId, 0);
    assert.equal(client.addresses.humanRoot, ROOT);
    assert.equal(client.account, ROOT);
  });

  it("starts empty: one root node, zero treasury, no fixtures", async () => {
    const { client } = sandbox();
    assert.deepEqual(await client.getOrgTree(), [
      { account: ROOT, kind: "human_root", parent: null, active: true },
    ]);
    assert.deepEqual(await client.getAllowances(), []);
    assert.deepEqual(await client.getTreasuryBalances(), [
      {
        symbol: "USDC",
        token: client.addresses.mockUSDC,
        decimals: 6,
        total: 0n,
        liquid: 0n,
        reserved: 0n,
      },
    ]);
    assert.deepEqual(await client.getPendingIntents(), []);
    assert.deepEqual(await client.getSessions(), []);
    assert.deepEqual(await client.getProposals(), []);
    assert.deepEqual(await client.getGrants(), []);
    assert.equal(await client.getCurrentEpoch(), 0);
    assert.deepEqual(await client.getAuditTrail(), []);
    assert.deepEqual(await client.readGovernanceSeats(), [
      { voter: ROOT, power: "2", role: "human" },
    ]);
  });

  it("needs a root to deploy, and nothing else", () => {
    assert.throws(() => createSandboxClient({ clock: manualClock(T0) }), /human root/);
  });

  it("refuses an asset it has no stack for, like the onchain client", async () => {
    const { client } = sandbox();
    await assert.rejects(client.getAllowances(undefined, "WETH"), /No asset stack "WETH"/);
    assert.equal(await client.getCurrentEpoch("usdc"), 0);
  });
});

describe("sandbox client: an org's life", () => {
  it("hires, funds, spends, escalates to the root and settles", async () => {
    const { client } = sandbox();
    await crew(client);

    assert.deepEqual(
      (await client.getOrgTree()).map((n) => [n.account, n.kind, n.parent]),
      [
        [ROOT, "human_root", null],
        [MANAGER, "manager_agent", ROOT],
        [WORKER, "worker_agent", MANAGER],
      ],
    );
    assert.deepEqual(await client.getAllowances(), [
      { node: MANAGER, token: client.addresses.mockUSDC, balance: 0n, epoch: 1, cap: 50n * USDC },
      {
        node: WORKER,
        token: client.addresses.mockUSDC,
        balance: 200n * USDC,
        epoch: 1,
        cap: 50n * USDC,
      },
    ]);

    const allowed = await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 40n * USDC,
    });
    assert.equal(allowed.verdict, "ALLOW");
    assert.equal(allowed.intentId, "0");

    const escalated = await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 75n * USDC,
    });
    assert.equal(escalated.verdict, "ESCALATE");
    const [pending] = await client.getPendingIntents();
    assert.equal(pending!.id, escalated.intentId);
    assert.equal(pending!.awaitingApprover, MANAGER);
    assert.equal(pending!.verdict, "ESCALATE");
    assert.deepEqual(await client.simulateResolveApproval(pending!.id), { ok: true });

    // The manager's own cap is the default 50: its approval climbs to the root.
    const climbed = await client.resolveIntent(pending!.id, true);
    assert.equal(climbed.escalated, true);
    assert.equal(climbed.intent.awaitingApprover, ROOT);

    const settled = await client.resolveIntent(pending!.id, true);
    assert.equal(settled.escalated, false);
    assert.equal(settled.intent.approved, true);
    assert.equal(settled.intent.verdict, "ALLOW");
    assert.deepEqual(await client.getPendingIntents(), []);

    const [worker] = await client.getAllowances(WORKER);
    assert.equal(worker!.balance, 85n * USDC);
    const [balances] = await client.getTreasuryBalances();
    assert.equal(balances!.total, 10_000n * USDC - 115n * USDC);
    assert.equal(balances!.reserved, 85n * USDC);
    assert.equal(balances!.liquid, 10_000n * USDC - 200n * USDC);
  });

  it("settles as the root when the awaiting approver has been deactivated", async () => {
    const { client } = sandbox();
    await crew(client);
    const { intentId } = await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 75n * USDC,
    });
    await pass(client, client.proposeSetActive({ account: MANAGER, active: false }));

    // Named, the manager is refused; unnamed, the client signs as the stand-in.
    await assert.rejects(
      client.resolveIntent(intentId, true, MANAGER),
      revertsWith("InactiveApprover"),
    );
    assert.deepEqual(await client.simulateResolveApproval(intentId), { ok: true });
    const settled = await client.resolveIntent(intentId, true);
    assert.equal(settled.escalated, false);
    assert.equal(settled.intent.approved, true);
  });

  it("reports an approval for a deactivated agent as one that would revert", async () => {
    const { client } = sandbox();
    await crew(client);
    const { intentId } = await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 75n * USDC,
    });
    await pass(client, client.proposeSetActive({ account: WORKER, active: false }));

    assert.deepEqual(await client.simulateResolveApproval(intentId), {
      ok: false,
      reason: "InactiveAgent",
    });
    await assert.rejects(client.resolveIntent(intentId, true), revertsWith("InactiveAgent"));
    const denied = await client.resolveIntent(intentId, false);
    assert.equal(denied.intent.approved, false);
  });

  it("a rejected intent closes as denied and moves nothing", async () => {
    const { client } = sandbox();
    await crew(client);
    const { intentId } = await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 75n * USDC,
    });
    const out = await client.resolveIntent(intentId, false, MANAGER);
    assert.equal(out.intent.verdict, "DENY");
    assert.equal(out.intent.approved, false);
    await assert.rejects(
      client.resolveIntent(intentId, true, MANAGER),
      revertsWith("IntentAlreadyResolved"),
    );
  });

  it("reverts with the contract's own error names", async () => {
    const { client } = sandbox();
    await crew(client);
    const worker = client.as(WORKER);
    await assert.rejects(
      worker.proposeIntent({ agent: WORKER, target: STRANGER, value: 1n }),
      revertsWith("UnexpectedVerdict"),
    );
    await assert.rejects(
      client.as(STRANGER).proposeIntent({ agent: WORKER, target: TARGET, value: 1n }),
      revertsWith("InvalidSession"),
    );
    await assert.rejects(
      worker.proposeIntent({ agent: WORKER, target: client.addresses.treasury, value: 1n }),
      revertsWith("ProtectedTarget"),
    );
    await assert.rejects(client.as(STRANGER).runEpoch(), revertsWith("NotOperator"));
    // Proposal 1 was executed while the crew was built.
    await assert.rejects(
      client.as(STRANGER).voteGovernance("1", true),
      revertsWith("ProposalNotActive"),
    );
    assert.deepEqual(await client.as(STRANGER).simulateResolveApproval("99"), {
      ok: false,
      reason: "IntentNotFound",
    });
  });

  it("a reverted write changes nothing and commits nothing", async () => {
    const { client, commits } = sandbox();
    await crew(client);
    const before = JSON.stringify(client.snapshot());
    const count = commits.length;
    await assert.rejects(
      client.as(WORKER).proposeIntent({ agent: WORKER, target: STRANGER, value: 1n }),
      SimRevert,
    );
    assert.equal(JSON.stringify(client.snapshot()), before);
    assert.equal(commits.length, count);
  });
});

describe("sandbox client: who is calling", () => {
  it("takes msg.sender from the account argument", async () => {
    const { client } = sandbox();
    await crew(client);
    const session = await client.issueSession({
      agent: WORKER,
      key: KEY,
      expiresAtSec: T0 + DAY,
      scopeMask: sessionScopeMask(["propose:intent", "spend:whitelist"]),
      maxValue: 10n * USDC,
      allowedTarget: TARGET,
    });
    assert.equal(session.sessionId, "1");

    // The root's client proposes, but the key is the sender the router sees.
    const ok = await client.proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 10n * USDC,
      account: { address: KEY },
    });
    assert.equal(ok.verdict, "ALLOW");
    await assert.rejects(
      client.proposeIntent({
        agent: WORKER,
        target: TARGET,
        value: 11n * USDC,
        account: { address: KEY },
      }),
      revertsWith("SessionValueExceeded"),
    );
    // Without the argument the sender is the client's own account: the root holds no session.
    await assert.rejects(
      client.proposeIntent({ agent: WORKER, target: TARGET, value: 1n }),
      revertsWith("InvalidSession"),
    );
  });

  it("issues and revokes as the issuer account, and reads the key back", async () => {
    const { client, clock } = sandbox();
    await crew(client);
    await assert.rejects(
      client.as(STRANGER).issueSession({
        agent: WORKER,
        key: KEY,
        expiresAtSec: T0 + DAY,
        scopeMask: 1n,
      }),
      revertsWith("NotAuthorized"),
    );
    await client.issueSession({
      agent: WORKER,
      key: KEY,
      expiresAtSec: T0 + DAY,
      scopeMask: 3n,
      maxValue: 5n,
      allowedTargets: [TARGET, STRANGER],
      window: { start: 0, end: DAY },
      rate: { maxProposals: 3, ratePeriod: 60 },
    });
    assert.deepEqual(await client.readKeyLimits(WORKER, KEY), {
      valid: true,
      maxValue: 5n,
      allowedTarget: TARGET,
      window: { start: 0, end: DAY },
      rate: { maxProposals: 3, ratePeriod: 60 },
    });
    assert.deepEqual(await client.getSessions(WORKER), [
      {
        agent: WORKER,
        keyId: "1",
        keyAddress: KEY,
        expiresAt: (T0 + DAY) * 1000,
        scopes: ["propose:intent", "spend:whitelist"],
        maxValue: "5",
        allowedTarget: TARGET,
        allowedTargets: [TARGET, STRANGER],
        window: { start: 0, end: DAY },
        rate: { maxProposals: 3, ratePeriod: 60 },
        revoked: false,
      },
    ]);
    assert.equal(await client.getIssuer(), ROOT);

    // Expiry follows the sandbox clock, not the wall clock.
    clock.advance(DAY);
    assert.equal((await client.getSessions(WORKER))[0]!.revoked, true);
    assert.deepEqual(await client.readKeyLimits(WORKER, KEY), {
      valid: false,
      maxValue: 0n,
      allowedTarget: "0x0000000000000000000000000000000000000000",
    });
    await client.revokeSession("1");
    await assert.rejects(client.revokeSession("1"), revertsWith("AlreadyRevoked"));
  });

  it("as() shares one state between senders", async () => {
    const { client } = sandbox();
    const stranger = client.as(STRANGER);
    assert.equal(stranger.account, STRANGER);
    await pass(client, client.proposeHire({ label: "x", account: WORKER }));
    assert.equal((await stranger.getOrgTree()).length, 2);
    // Anyone may propose; only a seat may vote.
    const { proposalId } = await stranger.proposeFire({ account: WORKER });
    assert.equal((await client.getProposal(proposalId)).proposer, STRANGER);
    await assert.rejects(stranger.voteGovernance(proposalId, true), revertsWith("NoVotingPower"));
  });
});

describe("sandbox client: governance", () => {
  it("encodes the action a proposal will run and executes it by decoding it", async () => {
    const { client } = sandbox();
    const { proposalId, account } = await client.proposeHire({
      label: "ops",
      kind: "manager_agent",
    });
    const proposal = await client.getProposal(proposalId);
    assert.equal(proposal.target, client.addresses.orgRegistry);
    assert.equal(proposal.tier, "low");
    assert.equal(proposal.state, "active");
    assert.equal(
      proposal.data,
      encodeFunctionData({
        abi: orgRegistryAbi,
        functionName: "addNode",
        args: [account, 1, ROOT],
      }),
    );
    assert.equal(proposal.deadline, T0 + 3 * DAY);

    await assert.rejects(client.executeGovernance(proposalId), revertsWith("QuorumNotMet"));
    await client.voteGovernance(proposalId, true);
    assert.equal(await client.readHasVoted(proposalId, ROOT), true);
    await client.executeGovernance(proposalId);
    assert.equal((await client.getProposal(proposalId)).state, "executed");
    assert.ok((await client.getOrgTree()).some((n) => n.account === account));
  });

  it("admits a second human, after which the timelock binds", async () => {
    const { client, clock } = sandbox();
    const second = named("a9");
    await pass(client, client.proposeAdmitHuman({ account: second, power: 2n }));
    const config = await client.readGovernanceConfig();
    assert.equal(config.humanSeatCount, "2");
    assert.equal(config.totalHumanVotingPower, "4");
    assert.equal(config.effectiveQuorumYes, "2");
    assert.equal(config.votingPeriod, 3 * DAY);
    assert.deepEqual(await client.readGovernanceSeats(), [
      { voter: ROOT, power: "2", role: "human" },
      { voter: second, power: "2", role: "human" },
    ]);

    const { proposalId } = await client.proposeSetWhitelist({ target: TARGET, allowed: true });
    await client.voteGovernance(proposalId, true);
    await assert.rejects(client.executeGovernance(proposalId), revertsWith("TimelockNotElapsed"));
    clock.advance(4 * DAY);
    await client.executeGovernance(proposalId);
    assert.equal(
      await client.checkPolicy({
        agent: ROOT,
        target: TARGET,
        value: 1n,
        policyModule: client.addresses.whitelistPolicy,
      }),
      "ALLOW",
    );

    const veto = await client.proposeRemoveHuman({ account: second });
    await client.as(second).vetoGovernance(veto.proposalId);
    assert.equal((await client.getProposal(veto.proposalId)).state, "vetoed");
  });

  it("changes caps, grants, activity and reporting lines by proposal", async () => {
    const { client } = sandbox();
    await crew(client);
    await pass(client, client.proposeSetAgentCap({ agent: WORKER, cap: 500n * USDC }));
    assert.equal(await client.capOf(WORKER), 500n * USDC);

    await pass(
      client,
      client.proposeSetGrants({
        entries: [
          { account: WORKER, amount: 0n },
          { account: MANAGER, amount: 7n },
        ],
      }),
    );
    assert.deepEqual(await client.getGrants(), [{ account: MANAGER, amount: "7" }]);

    await pass(client, client.proposeSetActive({ account: WORKER, active: false }));
    await assert.rejects(
      client.as(WORKER).proposeIntent({ agent: WORKER, target: TARGET, value: 1n }),
      revertsWith("InactiveAgent"),
    );
    await pass(client, client.proposeReparent({ account: WORKER, newParent: ROOT }));
    await pass(client, client.proposeFire({ account: MANAGER }));
    assert.deepEqual(
      (await client.getOrgTree()).map((n) => [n.account, n.parent, n.active]),
      [
        [ROOT, null, true],
        [WORKER, ROOT, false],
      ],
    );
  });

  it("deploys a node's own modules and binds them by proposal", async () => {
    const { client } = sandbox();
    await crew(client);
    const rate = await client.deployRateLimitPolicy({ maxActions: 1, windowSeconds: 600 });
    const window = await client.deployTimeWindowPolicy({
      startSecondOfDay: 0,
      endSecondOfDay: DAY,
    });
    const stack = await client.deployPolicyStack([
      client.addresses.whitelistPolicy!,
      rate.address,
      window.address,
    ]);
    await pass(client, client.proposeSetNodePolicy({ node: WORKER, policyModule: stack.address }));
    await pass(
      client,
      client.proposeSetNodeRateRecorder({ node: WORKER, rateRecorder: rate.address }),
    );
    assert.equal(await client.readNodeRateRecorder(WORKER), rate.address);

    const worker = client.as(WORKER);
    const first = await worker.proposeIntent({ agent: WORKER, target: TARGET, value: 1n });
    const second = await worker.proposeIntent({ agent: WORKER, target: TARGET, value: 1n });
    assert.deepEqual([first.verdict, second.verdict], ["ALLOW", "ESCALATE"]);

    const [policy] = await client.getNodePolicies({ nodes: [WORKER] });
    assert.equal(policy!.source, "node");
    assert.equal(policy!.policyModule, stack.address);
    assert.deepEqual(policy!.modules, [
      {
        address: client.addresses.whitelistPolicy,
        kind: "whitelist",
        allowedTargets: [TARGET],
      },
      {
        address: rate.address,
        kind: "rate_limit",
        maxActions: 1,
        windowSeconds: 600,
        windowStartSec: T0,
        actionsUsed: 2,
      },
      { address: window.address, kind: "time_window", startSecondOfDay: 0, endSecondOfDay: DAY },
    ]);

    const [fallback] = await client.getNodePolicies({ nodes: [MANAGER] });
    assert.equal(fallback!.source, "default");
    assert.deepEqual(
      fallback!.modules.map((m) => m.kind),
      ["time_window", "whitelist", "spend_cap", "rate_limit"],
    );
    assert.deepEqual(fallback!.modules[2], {
      address: client.addresses.spendCapPolicy,
      kind: "spend_cap",
      defaultCap: (50n * USDC).toString(),
      cap: (50n * USDC).toString(),
      capIsExplicit: false,
    });
  });
});

describe("sandbox client: writes are named by simTxId", () => {
  it("never returns a txHash", async () => {
    const { client } = sandbox();
    const results: object[] = [];
    results.push(await client.proposeHire({ label: "m", kind: "manager_agent", account: MANAGER }));
    results.push(await client.voteGovernance("1", true));
    results.push(await client.executeGovernance("1"));
    results.push(await client.fund(1n));
    results.push(await client.setIssuer(ROOT));
    results.push(
      await client.issueSession({ agent: MANAGER, key: KEY, expiresAtSec: T0 + 60, scopeMask: 1n }),
    );
    results.push(await client.revokeSession("1"));
    results.push(await client.proposeGovernance({ tier: "low", target: TARGET, data: "0x" }));
    results.push(await client.vetoGovernance("2"));
    for (const [i, result] of results.entries()) {
      assert.equal("txHash" in result, false);
      assert.equal(
        (result as { simTxId: string }).simTxId,
        `simtx_${String(i + 1).padStart(8, "0")}`,
      );
    }
  });

  it("reports each commit, with a snapshot that restores the same sandbox", async () => {
    const { client, clock, commits } = sandbox();
    await crew(client);
    assert.equal(commits.at(-1)!.simTxId, "simtx_00000014");
    assert.equal(commits.at(-1)!.sender, ROOT);
    assert.equal(commits.at(-1)!.at, T0);
    assert.deepEqual(
      commits.at(-1)!.events.map((e) => e.name),
      ["AllowanceStreamed", "EpochRun"],
    );

    const text = JSON.stringify(commits.at(-1)!.snapshot());
    const restored = createSandboxClient({ snapshot: JSON.parse(text), clock });
    assert.deepEqual(restored.world, client.world);
    assert.deepEqual(await restored.getOrgTree(), await client.getOrgTree());
    const next = await restored.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 1n,
    });
    assert.equal(next.simTxId, "simtx_00000015");
  });

  it("keeps an audit trail of what the contracts emitted", async () => {
    const { client } = sandbox();
    await crew(client);
    await client.as(WORKER).proposeIntent({ agent: WORKER, target: TARGET, value: 40n * USDC });
    const trail = await client.getAuditTrail();
    assert.deepEqual(trail.slice(-3), [
      {
        type: "AllowanceStreamed",
        at: new Date(T0 * 1000).toISOString(),
        payload: {
          node: WORKER,
          amount: (200n * USDC).toString(),
          epoch: 1,
          simTxId: "simtx_00000014",
        },
      },
      {
        type: "AllowanceSpent",
        at: new Date(T0 * 1000).toISOString(),
        payload: {
          agent: WORKER,
          target: TARGET,
          value: (40n * USDC).toString(),
          simTxId: "simtx_00000015",
        },
      },
      {
        type: "ActionExecuted",
        at: new Date(T0 * 1000).toISOString(),
        payload: {
          agent: WORKER,
          target: TARGET,
          value: (40n * USDC).toString(),
          callOk: true,
          simTxId: "simtx_00000015",
        },
      },
    ]);
    assert.ok(trail.every((e) => !("txHash" in e.payload)));
    assert.ok(trail.some((e) => e.type === "ProposalExecuted"));
    assert.ok(trail.some((e) => e.type === "TreasuryDeposit"));
  });
});

describe("sandbox client: calls by address", () => {
  it("accepts the calldata a chain would be sent", async () => {
    const { client } = sandbox();
    await crew(client);
    const sent = client.sendTransaction({
      from: WORKER,
      to: client.addresses.escalationRouter,
      data: encodeFunctionData({
        abi: escalationRouterAbi,
        functionName: "propose",
        args: [WORKER, TARGET, 75n * USDC, "0x"],
      }),
    });
    assert.deepEqual(sent.outcome, {
      kind: "contract",
      contract: "EscalationRouter",
      functionName: "propose",
      result: { intentId: 1n, verdict: 1 },
    });
    assert.equal(
      client.call({
        to: client.addresses.treasury,
        data: encodeFunctionData({
          abi: treasuryAbi,
          functionName: "allowanceBalance",
          args: [WORKER],
        }),
      }),
      200n * USDC,
    );
  });

  it("an unknown target is recorded and succeeds, as a call to an EOA would", async () => {
    const { client, commits } = sandbox();
    await crew(client);
    // Straight to an address with no contract.
    const sent = client.sendTransaction({ to: STRANGER, data: "0x12345678" });
    assert.deepEqual(sent.outcome, { kind: "external" });
    assert.deepEqual(commits.at(-1)!.events, [
      {
        address: STRANGER,
        contract: "External",
        name: "ExternalCall",
        args: { from: ROOT, target: STRANGER, data: "0x12345678" },
      },
    ]);

    // As the call an approved spend makes on its target.
    await client.as(WORKER).proposeIntent({
      agent: WORKER,
      target: TARGET,
      value: 1n,
      data: "0xfeedface",
    });
    const events = commits.at(-1)!.events;
    assert.deepEqual(
      events.map((e) => e.name),
      ["Transfer", "AllowanceSpent", "ExternalCall", "ActionExecuted"],
    );
    assert.equal(events.at(-1)!.args.callOk, true);
    assert.deepEqual(events[2]!.args, {
      from: client.addresses.escalationRouter,
      target: TARGET,
      data: "0xfeedface",
    });

    // And as the action of an executed proposal.
    await pass(client, client.proposeGovernance({ tier: "low", target: STRANGER, data: "0x01" }));
    assert.ok(commits.at(-1)!.events.some((e) => e.name === "ExternalCall"));
  });

  it("a proposal whose calldata no contract function answers fails to execute", async () => {
    const { client } = sandbox();
    const { proposalId } = await client.proposeGovernance({
      tier: "low",
      target: client.addresses.orgRegistry,
      data: "0xdeadbeef",
    });
    await client.voteGovernance(proposalId, true);
    await assert.rejects(client.executeGovernance(proposalId), revertsWith("ActionFailed"));
    assert.equal((await client.getProposal(proposalId)).state, "active");
    assert.throws(
      () => client.sendTransaction({ to: client.addresses.orgRegistry, data: "0xdeadbeef" }),
      revertsWith("EvmRevert"),
    );
  });

  it("refuses an enum value past its last member, as the ABI decoder does", () => {
    const { client } = sandbox();
    const send = (data: `0x${string}`, to: `0x${string}`) => () =>
      client.sendTransaction({ to, data });
    assert.throws(
      send(
        encodeFunctionData({
          abi: orgRegistryAbi,
          functionName: "addNode",
          args: [WORKER, 3, ROOT],
        }),
        client.addresses.orgRegistry,
      ),
      revertsWith("EvmRevert"),
    );
    assert.throws(
      send(
        encodeFunctionData({
          abi: governanceModuleAbi,
          functionName: "propose",
          args: [2, TARGET, "0x"],
        }),
        client.addresses.governanceModule,
      ),
      revertsWith("EvmRevert"),
    );
    assert.throws(
      send(
        encodeFunctionData({
          abi: governanceModuleAbi,
          functionName: "setVotingPower",
          args: [WORKER, 1n, 3],
        }),
        client.addresses.governanceModule,
      ),
      revertsWith("EvmRevert"),
    );
  });

  it("names a function it does not model instead of guessing", () => {
    const { client } = sandbox();
    assert.throws(
      () =>
        client.call({
          to: client.addresses.governanceModule,
          data: encodeFunctionData({ abi: governanceModuleAbi, functionName: "MAX_TIMELOCK" }),
        }),
      revertsWith("NotSimulated"),
    );
  });
});

describe("sandbox client: what needs a chain", () => {
  it("refuses marketplace payments by name", async () => {
    const { client } = sandbox();
    const refusals = [
      client.quoteListing("skill"),
      client.getListing("skill"),
      client.hasPurchased("skill", ROOT),
      client.registerListing({ catalogId: "skill", price: 1n }),
      client.purchaseListing({ catalogId: "skill" }),
      client.proposeMarketplacePurchase({ agent: WORKER, catalogId: "skill" }),
      client.marketplaceEarnings(ROOT),
      client.withdrawMarketplaceEarnings(),
    ];
    for (const refusal of refusals) {
      await assert.rejects(refusal, (err: unknown) => {
        assert.ok(err instanceof SandboxNeedsChainError);
        assert.equal(err.code, "needs_chain");
        assert.match(err.message, /Marketplace payments needs a chain/);
        return true;
      });
    }
    assert.equal(client.addresses.marketplacePayments, undefined);
  });

  it("refuses x402 settlement and the token faucet, without committing anything", () => {
    const { client, commits } = sandbox();
    const settle = encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: "transferWithAuthorization",
      args: [ROOT, TARGET, 1n, 0n, 2n ** 64n, `0x${"00".repeat(32)}`, "0x"],
    });
    assert.throws(
      () => client.sendTransaction({ to: client.addresses.mockUSDC!, data: settle }),
      (err: unknown) =>
        err instanceof SandboxNeedsChainError &&
        /x402 settlement .* needs a chain/.test(err.message),
    );
    assert.throws(
      () =>
        client.sendTransaction({
          to: client.addresses.mockUSDC!,
          data: encodeFunctionData({ abi: mockUsdcAbi, functionName: "faucet" }),
        }),
      SandboxNeedsChainError,
    );
    assert.equal(commits.length, 0);
  });
});

describe("sandbox client: a denied propose names its rule", () => {
  const denied = async (run: Promise<unknown>) => {
    const err = await run.then(
      () => assert.fail("the propose was not denied"),
      (caught: unknown) => caught,
    );
    assert.ok(revertsWith("UnexpectedVerdict")(err), String(err));
    return policyDenialOf(err);
  };

  it("names the allowlist and the target it does not hold", async () => {
    const { client } = sandbox();
    await crew(client);
    const input = { agent: WORKER, target: STRANGER, value: 1n };
    const denial = await denied(client.as(WORKER).proposeIntent(input));
    assert.deepEqual(denial, {
      module: client.addresses.whitelistPolicy,
      kind: "whitelist",
      reason: "target_not_allowlisted",
      detail: `Target ${STRANGER} is not on the allowlist.`,
      target: STRANGER,
    });
    // The same answer without proposing, and none for an action nothing denies.
    assert.deepEqual(await client.explainDenial(input), denial);
    assert.equal(await client.explainDenial({ ...input, target: TARGET }), null);
    assert.equal(
      await client.explainDenial({ ...input, target: TARGET, value: 75n * USDC }),
      null,
      "an escalation is not a denial",
    );
  });

  it("names the time window of the node's own stack, and the clock it was asked at", async () => {
    const { client, clock } = sandbox();
    await crew(client);
    // T0 is 80 000 seconds into its UTC day; the window is the day's first hour.
    const window = await client.deployTimeWindowPolicy({
      startSecondOfDay: 0,
      endSecondOfDay: 3_600,
    });
    const stack = await client.deployPolicyStack([
      client.addresses.whitelistPolicy!,
      window.address,
    ]);
    await pass(client, client.proposeSetNodePolicy({ node: WORKER, policyModule: stack.address }));
    const worker = client.as(WORKER);

    const secondOfDay = clock.now() % DAY;
    const denial = await denied(worker.proposeIntent({ agent: WORKER, target: TARGET, value: 1n }));
    assert.equal(denial?.module, window.address);
    assert.equal(denial?.kind, "time_window");
    assert.equal(denial?.reason, "outside_time_window");
    assert.deepEqual(
      [denial?.startSecondOfDay, denial?.endSecondOfDay, denial?.secondOfDay],
      [0, 3_600, secondOfDay],
    );
    assert.match(denial!.detail, /^Outside the allowed time window \(00:00-01:00 UTC; /);

    // Both rules refuse this one; the first in check order is the one named.
    const both = await denied(worker.proposeIntent({ agent: WORKER, target: STRANGER, value: 1n }));
    assert.equal(both?.reason, "target_not_allowlisted");

    // Inside the window nothing denies, and the propose goes through.
    clock.advance(DAY - secondOfDay + 60);
    assert.equal(await client.explainDenial({ agent: WORKER, target: TARGET, value: 1n }), null);
    const allowed = await worker.proposeIntent({ agent: WORKER, target: TARGET, value: 1n });
    assert.equal(allowed.verdict, "ALLOW");
  });

  it("leaves every other revert as it was", async () => {
    const { client } = sandbox();
    await crew(client);
    const err = await client
      .as(STRANGER)
      .proposeIntent({ agent: WORKER, target: TARGET, value: 1n })
      .catch((caught: unknown) => caught);
    assert.ok(revertsWith("InvalidSession")(err));
    assert.equal(policyDenialOf(err), undefined);
  });
});
