/**
 * Two orgs in one database, table by table.
 *
 * Every table carries `org_id` and every key includes it, so two orgs may use
 * the same id for different things. Each case below writes one key under two
 * orgs, reads each back, then deletes or changes one side and checks the other
 * did not move. Needs a real Postgres (the Stores job); skipped without one.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addInferenceUsage,
  allAgentControlRows,
  claimCrewHeartbeatTick,
  claimInferenceAlert,
  claimWaitingFlowRun,
  claimWebhookDelivery,
  deleteConnectorMode,
  deleteCrewBinding,
  deleteCrewHeartbeat,
  deleteDualControlRule,
  deleteExternalMcpSecret,
  deleteExternalMcpServer,
  deleteExternalMcpTool,
  deleteFlowDefinition,
  deleteInferenceBudget,
  deletePlanRequirement,
  deleteSandboxRuntimeRows,
  deleteWebhookTrigger,
  getChildFlowRunState,
  getCrewHeartbeat,
  getFlowDefinition,
  getFlowRun,
  getFlowRunState,
  getInferenceBudget,
  getInferenceUsage,
  getWebhookTrigger,
  inferenceUsageEventsForRuns,
  insertFlowRun,
  insertInferenceUsageEvent,
  insertIntentRow,
  insertMessageRow,
  insertTxGas,
  listChildFlowRunStates,
  listConnectorModes,
  listCrashedFlowWrites,
  listCrewBindings,
  listCrewHeartbeats,
  listDualControlRules,
  listExternalMcpSecrets,
  listExternalMcpServers,
  listExternalMcpTools,
  listFlowCheckpoints,
  listFlowDefinitions,
  listFlowRunStates,
  listInferenceBudgets,
  listPlanRequirements,
  listWebhookTriggers,
  loadSandboxState,
  markSessionRevokedRow,
  orgDb,
  pruneFlowRunState,
  recentAuditEvents,
  recentConnectorAsks,
  recentCrewHeartbeatTicks,
  recentDualControlReviews,
  recentFlowRuns,
  recentHumanGates,
  recentInferenceUsageEvents,
  recentIntentRows,
  recentMessageRows,
  recentSessionRows,
  recentWebhookDeliveries,
  recordFlowCheckpoint,
  resolveIntentRows,
  saveSandboxState,
  setFlowRunAttempt,
  setTxGasAgent,
  sumTxGasByAgent,
  upsertAgentControlRow,
  upsertConnectorAsk,
  upsertConnectorMode,
  upsertCrewBinding,
  upsertCrewHeartbeat,
  upsertDualControlReview,
  upsertDualControlRule,
  upsertExternalMcpSecret,
  upsertExternalMcpServer,
  upsertExternalMcpTool,
  upsertFlowDefinition,
  upsertFlowRunState,
  upsertHumanGate,
  upsertInferenceBudget,
  upsertPlanRequirement,
  upsertSessionRow,
  upsertWebhookTrigger,
  type OrgDb,
} from "@lacrew/db";
import { createPgAuditStore } from "./auditStore.js";
import { closeSharedDb, sharedDb } from "./dbPool.js";

const PG = Boolean(process.env.DATABASE_URL);

after(async () => closeSharedDb());

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** Two orgs of this run's own, so a shared database's other rows stay out. */
function twoOrgs(): [OrgDb, OrgDb] {
  const run = tag();
  return [orgDb(sharedDb(), `a-${run}`), orgDb(sharedDb(), `b-${run}`)];
}

const NOW = "2026-05-01T12:00:00.000Z";
const LATER = "2026-05-01T13:00:00.000Z";
const AGENT = "0x1111111111111111111111111111111111111111";

describe("org scope (postgres)", { skip: !PG }, () => {
  it("refuses an org id that is not a slug", () => {
    for (const bad of ["", "A", "a b", "a/b", "x".repeat(65), "o'; drop table x; --"]) {
      assert.throws(() => orgDb(sharedDb(), bad), /org id/);
    }
    assert.equal(orgDb(sharedDb(), "tenant_1-a").orgId, "tenant_1-a");
  });

  it("sessions, intents, agent controls and messages", async () => {
    const [a, b] = twoOrgs();
    const session = (agent: string) => ({
      keyId: "1",
      agent,
      expiresAt: LATER,
      scopes: ["spend"],
      mode: "onchain",
      status: "active",
      issuedAt: NOW,
    });
    await upsertSessionRow(a, session(AGENT));
    await upsertSessionRow(b, session("0x2222222222222222222222222222222222222222"));
    assert.equal((await recentSessionRows(a, 10))[0]?.agent, AGENT);
    assert.equal((await recentSessionRows(b, 10)).length, 1);
    await markSessionRevokedRow(a, "1", LATER);
    assert.equal((await recentSessionRows(a, 10))[0]?.status, "revoked");
    assert.equal((await recentSessionRows(b, 10))[0]?.status, "active");

    const intent = (ledger: "chain" | "sandbox") => ({
      intentId: "7",
      agent: AGENT,
      target: AGENT,
      value: "1",
      verdict: "ESCALATE",
      status: "pending",
      proposedAt: NOW,
      ledger,
    });
    await insertIntentRow(a, intent("chain"));
    await insertIntentRow(b, intent("chain"));
    await insertIntentRow(a, intent("sandbox"));
    await insertIntentRow(b, intent("sandbox"));
    await resolveIntentRows(a, "7", { status: "approved", resolvedAt: LATER });
    assert.equal((await recentIntentRows(a, 10))[0]?.status, "approved");
    assert.equal((await recentIntentRows(b, 10))[0]?.status, "pending");
    // A sandbox reset in one org deletes only that org's simulated rows.
    await upsertSessionRow(a, { ...session(AGENT), ledger: "sandbox" });
    await upsertSessionRow(b, { ...session(AGENT), ledger: "sandbox" });
    await deleteSandboxRuntimeRows(a);
    assert.deepEqual(await recentIntentRows(a, 10, "sandbox"), []);
    assert.deepEqual(await recentSessionRows(a, 10, "sandbox"), []);
    assert.equal((await recentIntentRows(b, 10, "sandbox")).length, 1);
    assert.equal((await recentSessionRows(b, 10, "sandbox")).length, 1);
    assert.equal((await recentIntentRows(a, 10)).length, 1, "chain rows stay");

    const control = (paused: boolean) => ({ agent: AGENT, paused, layers: [], updatedAt: NOW });
    await upsertAgentControlRow(a, control(true));
    await upsertAgentControlRow(b, control(false));
    assert.deepEqual(
      (await allAgentControlRows(a)).map((r) => r.paused),
      [true],
    );
    assert.deepEqual(
      (await allAgentControlRows(b)).map((r) => r.paused),
      [false],
    );

    const message = (body: string) => ({
      id: "m1",
      threadId: "org",
      at: NOW,
      author: "x",
      authorKind: "human",
      kind: "note",
      body,
    });
    await insertMessageRow(a, message("from a"));
    await insertMessageRow(b, message("from b"));
    assert.deepEqual(
      (await recentMessageRows(a, 10)).map((m) => m.body),
      ["from a"],
    );
    assert.deepEqual(
      (await recentMessageRows(b, 10)).map((m) => m.body),
      ["from b"],
    );
  });

  it("flows, runs, run state, checkpoints and human gates", async () => {
    const [a, b] = twoOrgs();
    await upsertFlowDefinition(a, { id: "f", name: "A flow", definition: { id: "f" } });
    await upsertFlowDefinition(b, { id: "f", name: "B flow", definition: { id: "f" } });
    assert.equal((await getFlowDefinition(a, "f"))?.name, "A flow");
    assert.equal((await getFlowDefinition(b, "f"))?.name, "B flow");
    assert.equal((await listFlowDefinitions(a)).length, 1);

    const run = (status: string) => ({
      runId: "r",
      flowId: "f",
      status,
      startedAt: NOW,
      finishedAt: LATER,
      result: { status },
    });
    await insertFlowRun(a, run("completed"));
    await insertFlowRun(b, run("error"));
    assert.equal((await getFlowRun(a, "r"))?.status, "completed");
    assert.equal((await getFlowRun(b, "r"))?.status, "error");
    assert.equal((await recentFlowRuns(a, 10)).length, 1);

    const state = (status: string) => ({
      runId: "r",
      flowId: "f",
      status,
      startedAt: NOW,
      parentRunId: "p",
      parentStepId: "s",
    });
    await upsertFlowRunState(a, state("waiting"));
    await upsertFlowRunState(b, state("waiting"));
    assert.equal((await claimWaitingFlowRun(a, "r"))?.status, "running");
    assert.equal((await getFlowRunState(b, "r"))?.status, "waiting", "b was not claimed by a");
    assert.equal((await listFlowRunStates(a, ["waiting"])).length, 0);
    assert.equal((await listFlowRunStates(b, ["waiting"])).length, 1);
    assert.equal((await getChildFlowRunState(a, "p", "s"))?.status, "running");
    assert.equal((await listChildFlowRunStates(b, "p")).length, 1);
    await setFlowRunAttempt(a, "r", { stepId: "x" });
    assert.equal((await listCrashedFlowWrites(a)).length, 1);
    assert.equal((await listCrashedFlowWrites(b)).length, 0);

    const checkpoint = {
      runId: "r",
      seq: 1,
      flowId: "f",
      stepId: "one",
      status: "running",
      at: NOW,
    };
    await recordFlowCheckpoint(a, checkpoint, { ...state("completed"), cursor: "two" });
    assert.equal((await listFlowCheckpoints(a, "r")).length, 1);
    assert.equal((await listFlowCheckpoints(b, "r")).length, 0);
    assert.equal((await getFlowRunState(b, "r"))?.status, "waiting");
    assert.equal(await pruneFlowRunState(a, new Date(Date.now() + 60_000)), 1);
    assert.equal(await getFlowRunState(a, "r"), null);
    assert.equal((await getFlowRunState(b, "r"))?.status, "waiting");

    const gate = (prompt: string) => ({
      id: "g",
      stepId: "s",
      prompt,
      options: [],
      principal: AGENT,
      threadId: "org",
      questionId: "q",
      status: "pending",
      createdAt: NOW,
      expiresAt: LATER,
    });
    await upsertHumanGate(a, gate("a?"));
    await upsertHumanGate(b, gate("b?"));
    assert.deepEqual(
      (await recentHumanGates(a, 10)).map((g) => g.prompt),
      ["a?"],
    );

    await deleteFlowDefinition(a, "f");
    assert.equal(await getFlowDefinition(a, "f"), null);
    assert.equal((await getFlowDefinition(b, "f"))?.name, "B flow");
  });

  it("webhook triggers and deliveries", async () => {
    const [a, b] = twoOrgs();
    const trigger = (flowId: string) => ({
      id: "hook",
      flowId,
      scheme: "lacrew",
      secretSealed: "{}",
      secretVersion: 1,
      enabled: true,
    });
    await upsertWebhookTrigger(a, trigger("fa"));
    await upsertWebhookTrigger(b, trigger("fb"));
    assert.equal((await getWebhookTrigger(a, "hook"))?.flowId, "fa");
    assert.equal((await getWebhookTrigger(b, "hook"))?.flowId, "fb");
    assert.equal((await listWebhookTriggers(a)).length, 1);
    const delivery = { triggerId: "hook", deliveryKey: "k", result: "accepted" };
    assert.equal(await claimWebhookDelivery(a, delivery), true);
    assert.equal(await claimWebhookDelivery(a, delivery), false, "a replay in one org");
    assert.equal(await claimWebhookDelivery(b, delivery), true, "the same key in another org");
    await deleteWebhookTrigger(a, "hook");
    assert.equal(await getWebhookTrigger(a, "hook"), null);
    assert.equal((await recentWebhookDeliveries(a, 10)).length, 0);
    assert.equal((await getWebhookTrigger(b, "hook"))?.flowId, "fb");
    assert.equal((await recentWebhookDeliveries(b, 10)).length, 1);
  });

  it("crew heartbeats and ticks", async () => {
    const [a, b] = twoOrgs();
    const beat = (schedule: string) => ({
      crewId: "crew",
      schedule,
      checklist: [],
      notifyOnOk: true,
      stopOnError: false,
      enabled: true,
      updatedAt: NOW,
    });
    await upsertCrewHeartbeat(a, beat("* * * * *"));
    await upsertCrewHeartbeat(b, beat("0 * * * *"));
    assert.equal((await getCrewHeartbeat(a, "crew"))?.schedule, "* * * * *");
    assert.equal((await getCrewHeartbeat(b, "crew"))?.schedule, "0 * * * *");
    const tick = { crewId: "crew", windowKey: "crew@1" };
    assert.equal(await claimCrewHeartbeatTick(a, tick), true);
    assert.equal(await claimCrewHeartbeatTick(a, tick), false);
    assert.equal(await claimCrewHeartbeatTick(b, tick), true, "the same window in another org");
    assert.equal((await recentCrewHeartbeatTicks(a, 10)).length, 1);
    await deleteCrewHeartbeat(a, "crew");
    assert.equal((await listCrewHeartbeats(a)).length, 0);
    assert.equal((await listCrewHeartbeats(b)).length, 1);
  });

  it("inference budgets, usage and usage events", async () => {
    const [a, b] = twoOrgs();
    const budget = (policy: string) => ({
      scopeKey: "crew:x",
      crewId: "x",
      period: "day",
      limits: {},
      policy,
      pauseHeartbeatOnBreach: true,
      enabled: true,
      updatedAt: NOW,
    });
    await upsertInferenceBudget(a, budget("block"));
    await upsertInferenceBudget(b, budget("warn"));
    assert.equal((await getInferenceBudget(a, "crew:x"))?.policy, "block");
    assert.equal((await getInferenceBudget(b, "crew:x"))?.policy, "warn");
    const delta = {
      scopeKey: "crew:x",
      periodKey: "p",
      inputTokens: 10,
      outputTokens: 1,
      usdMicros: 5,
      unpriced: false,
    };
    await addInferenceUsage(a, delta);
    await addInferenceUsage(a, delta);
    await addInferenceUsage(b, delta);
    assert.equal((await getInferenceUsage(a, "crew:x", "p"))?.calls, 2);
    assert.equal((await getInferenceUsage(b, "crew:x", "p"))?.calls, 1);
    const claim = { scopeKey: "crew:x", periodKey: "p", from: "ok", to: "warned" };
    assert.equal(await claimInferenceAlert(a, claim), true);
    assert.equal(await claimInferenceAlert(a, claim), false);
    assert.equal(await claimInferenceAlert(b, claim), true, "the same alert in another org");
    const event = {
      scopeKey: "crew:x",
      periodKey: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      priceSource: "table",
      tokensEstimated: false,
      runId: "r",
      at: NOW,
    };
    await insertInferenceUsageEvent(a, event);
    assert.equal((await recentInferenceUsageEvents(a, 10)).length, 1);
    assert.equal((await recentInferenceUsageEvents(b, 10)).length, 0);
    assert.equal((await inferenceUsageEventsForRuns(b, ["r"], 10)).length, 0);
    await deleteInferenceBudget(a, "crew:x");
    assert.equal((await listInferenceBudgets(a)).length, 0);
    assert.equal((await listInferenceBudgets(b)).length, 1);
  });

  it("connector modes and asks, plan and dual-control rules, reviews, crew bindings", async () => {
    const [a, b] = twoOrgs();
    const mode = (m: string) => ({
      scopeKey: "workspace",
      scope: {},
      route: "github.merge",
      mode: m,
      updatedAt: NOW,
    });
    await upsertConnectorMode(a, mode("ask"));
    await upsertConnectorMode(b, mode("block"));
    assert.deepEqual(
      (await listConnectorModes(a)).map((r) => r.mode),
      ["ask"],
    );
    await deleteConnectorMode(a, "workspace", "github.merge");
    assert.equal((await listConnectorModes(a)).length, 0);
    assert.deepEqual(
      (await listConnectorModes(b)).map((r) => r.mode),
      ["block"],
    );

    const ask = (route: string) => ({
      id: "ask1",
      connector: "github",
      route,
      method: "POST",
      path: "/x",
      fingerprint: "f",
      args: {},
      principal: AGENT,
      threadId: "org",
      questionId: "q",
      status: "pending",
      createdAt: NOW,
      expiresAt: LATER,
    });
    await upsertConnectorAsk(a, ask("ra"));
    await upsertConnectorAsk(b, ask("rb"));
    assert.deepEqual(
      (await recentConnectorAsks(a, 10)).map((r) => r.route),
      ["ra"],
    );

    const plan = (windowMs: number) => ({
      scopeKey: "workspace",
      scope: {},
      mode: "required",
      windowMs,
      minPlanChars: 1,
      acceptUpstreamPlan: false,
      updatedAt: NOW,
    });
    await upsertPlanRequirement(a, plan(1));
    await upsertPlanRequirement(b, plan(2));
    await deletePlanRequirement(a, "workspace");
    assert.equal((await listPlanRequirements(a)).length, 0);
    assert.deepEqual(
      (await listPlanRequirements(b)).map((r) => r.windowMs),
      [2],
    );

    const rule = (reviewer: string) => ({
      scopeKey: "workspace",
      scope: {},
      mode: "risky_writes",
      reviewer,
      minSpend: "0",
      connectorWrites: true,
      orgMutators: true,
      timeoutMs: 1000,
      reviewScope: "per_effect",
      updatedAt: NOW,
    });
    await upsertDualControlRule(a, rule("manager"));
    await upsertDualControlRule(b, rule("role:human"));
    await deleteDualControlRule(a, "workspace");
    assert.equal((await listDualControlRules(a)).length, 0);
    assert.deepEqual(
      (await listDualControlRules(b)).map((r) => r.reviewer),
      ["role:human"],
    );

    const review = (tool: string) => ({
      id: "rev1",
      tool,
      effect: "write",
      fingerprint: "f",
      reviewScope: "per_effect",
      released: 0,
      args: {},
      actor: AGENT,
      reviewer: "manager",
      reviewers: [],
      human: false,
      escalated: false,
      humanOverride: true,
      threadId: "org",
      questionId: "q",
      status: "pending",
      createdAt: NOW,
      expiresAt: LATER,
    });
    await upsertDualControlReview(a, review("ta"));
    await upsertDualControlReview(b, review("tb"));
    assert.deepEqual(
      (await recentDualControlReviews(a, 10)).map((r) => r.tool),
      ["ta"],
    );

    const binding = (account: string) => ({
      key: "bp/role",
      scopeKey: "bp",
      roleId: "role",
      account,
      label: null,
      blueprintId: null,
      crewId: null,
      updatedAt: NOW,
    });
    await upsertCrewBinding(a, binding("0xa"));
    await upsertCrewBinding(b, binding("0xb"));
    await deleteCrewBinding(a, "bp/role");
    assert.equal((await listCrewBindings(a)).length, 0);
    assert.deepEqual(
      (await listCrewBindings(b)).map((r) => r.account),
      ["0xb"],
    );
  });

  it("external MCP servers, tools and sealed credentials", async () => {
    const [a, b] = twoOrgs();
    await upsertExternalMcpServer(a, { id: "srv", config: { url: "https://a" }, updatedAt: NOW });
    await upsertExternalMcpServer(b, { id: "srv", config: { url: "https://b" }, updatedAt: NOW });
    const tool = (enabled: boolean) => ({
      scopeKey: "workspace",
      scope: {},
      server: "srv",
      tool: "do",
      enabled,
      updatedAt: NOW,
    });
    await upsertExternalMcpTool(a, tool(true));
    await upsertExternalMcpTool(b, tool(false));
    const secret = (sealed: string) => ({
      ownerKey: "workspace",
      ref: "token",
      sealed,
      hint: "…",
      updatedAt: NOW,
    });
    await upsertExternalMcpSecret(a, secret("sealed-a"));
    await upsertExternalMcpSecret(b, secret("sealed-b"));
    assert.deepEqual(
      (await listExternalMcpServers(a)).map((r) => r.config),
      [{ url: "https://a" }],
    );
    assert.deepEqual(
      (await listExternalMcpTools(a)).map((r) => r.enabled),
      [true],
    );
    assert.deepEqual(
      (await listExternalMcpSecrets(a)).map((r) => r.sealed),
      ["sealed-a"],
    );
    await deleteExternalMcpServer(a, "srv");
    await deleteExternalMcpTool(a, "workspace", "srv", "do");
    await deleteExternalMcpSecret(a, "workspace", "token");
    assert.equal((await listExternalMcpServers(a)).length, 0);
    assert.equal((await listExternalMcpTools(a)).length, 0);
    assert.equal((await listExternalMcpSecrets(a)).length, 0);
    assert.deepEqual(
      (await listExternalMcpServers(b)).map((r) => r.config),
      [{ url: "https://b" }],
    );
    assert.deepEqual(
      (await listExternalMcpTools(b)).map((r) => r.enabled),
      [false],
    );
    assert.deepEqual(
      (await listExternalMcpSecrets(b)).map((r) => r.sealed),
      ["sealed-b"],
    );
  });

  it("gas: one transaction hash under two orgs is two rows, summed apart", async () => {
    const [a, b] = twoOrgs();
    const chainId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const row = (feeWei: string) => ({
      chainId,
      txHash: "0xabc",
      at: NOW,
      action: "propose",
      payer: "orchestrator",
      status: "success",
      gasUsed: "21000",
      feeWei,
    });
    await insertTxGas(a, row("100"));
    await insertTxGas(a, row("100"));
    await insertTxGas(b, row("7"));
    await setTxGasAgent(a, chainId, "0xabc", AGENT);
    const from = "2026-05-01T00:00:00.000Z";
    const to = "2026-05-02T00:00:00.000Z";
    assert.deepEqual(await sumTxGasByAgent(a, from, to, { chainId }), [
      { agent: AGENT, payer: "orchestrator", feeWei: "100", txCount: 1 },
    ]);
    assert.deepEqual(await sumTxGasByAgent(b, from, to, { chainId }), [
      { agent: null, payer: "orchestrator", feeWei: "7", txCount: 1 },
    ]);
  });

  it("sandbox state: one row per org, each with its own version", async () => {
    const [a, b] = twoOrgs();
    assert.equal(
      await saveSandboxState(a, { version: 1, state: { n: "a" }, clockOffset: 5 }, 0),
      true,
    );
    assert.equal(
      await saveSandboxState(b, { version: 1, state: { n: "b" }, clockOffset: 0 }, 0),
      true,
    );
    assert.equal(
      await saveSandboxState(a, { version: 2, state: { n: "a2" }, clockOffset: 5 }, 1),
      true,
    );
    assert.deepEqual((await loadSandboxState(a))?.state, { n: "a2" });
    assert.deepEqual(await loadSandboxState(b), {
      orgId: b.orgId,
      version: 1,
      state: { n: "b" },
      clockOffset: 0,
    });
  });

  it("audit: each org reads, counts and clears only its own trail", async () => {
    const [a, b] = twoOrgs();
    const stores = [a, b].map((org) =>
      createPgAuditStore({ db: sharedDb(), orgId: org.orgId, ledger: "sandbox" }),
    );
    const [storeA, storeB] = stores as [(typeof stores)[0], (typeof stores)[0]];
    const event = { type: "SandboxFunded" as const, at: NOW, payload: { amount: "1" } };
    await storeA.append(event);
    await storeA.append(event);
    await storeB.append(event);
    assert.equal((await storeA.recent(10)).length, 2);
    assert.equal((await storeB.recent(10)).length, 1);
    assert.deepEqual(await storeA.countByTypeSince("2000-01-01T00:00:00.000Z"), {
      SandboxFunded: 2,
    });
    // The reader other services use: scoped when asked, spanning when not.
    assert.equal((await recentAuditEvents(sharedDb(), 50, { orgId: a.orgId })).length, 2);
    assert.equal((await recentAuditEvents(sharedDb(), 50, { orgId: b.orgId })).length, 1);

    await storeA.clearSandbox();
    assert.deepEqual(await storeA.recent(10), []);
    assert.equal((await storeB.recent(10)).length, 1, "another org's simulation is untouched");
  });
});
