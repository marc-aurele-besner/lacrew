import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DUAL_CONTROL_DEFAULT_TIMEOUT_MS,
  classifyDualEffect,
  concurrenceQualifies,
  dualControlRequired,
  formatReviewer,
  normalizeDualControlRule,
  parseReviewer,
  readReviewAnswer,
  resolveDualControl,
  resolveReviewer,
  type DualControlRecord,
  type DualControlRule,
  type DualControlSeat,
} from "./dualControl.js";

const HUMAN = "0x1111111111111111111111111111111111111111";
const MANAGER = "0x2222222222222222222222222222222222222222";
const WORKER = "0x3333333333333333333333333333333333333333";
const PEER = "0x4444444444444444444444444444444444444444";
const AT = "2026-07-31T12:00:00.000Z";

const CHART: DualControlSeat[] = [
  { account: HUMAN, kind: "human_root", parent: null, active: true },
  { account: MANAGER, kind: "manager_agent", parent: HUMAN, active: true },
  { account: WORKER, kind: "worker_agent", parent: MANAGER, active: true },
  { account: PEER, kind: "worker_agent", parent: MANAGER, active: true },
];

const rule = (over: Partial<DualControlRule> = {}): DualControlRecord =>
  normalizeDualControlRule(
    { scope: { level: "workspace" }, mode: "spends_and_writes", ...over },
    AT,
  );

describe("dual-control rules", () => {
  it("fills the defaults and round-trips the reviewer vocabulary", () => {
    const record = rule();
    assert.equal(record.mode, "spends_and_writes");
    assert.deepEqual(record.reviewer, { kind: "manager" });
    assert.equal(record.timeoutMs, DUAL_CONTROL_DEFAULT_TIMEOUT_MS);
    assert.equal(record.threshold.minSpend, "0");
    assert.equal(record.threshold.connectorWrites, true);
    assert.equal(record.threshold.orgMutators, true);

    for (const wire of ["manager", "role:human", "any_peer_in_crew", `seat:${MANAGER}`]) {
      const parsed = parseReviewer(wire);
      assert.ok(parsed, `${wire} should parse`);
      assert.equal(formatReviewer(parsed!), wire.toLowerCase());
    }
    assert.equal(parseReviewer("whoever"), null);
    assert.equal(parseReviewer("seat:"), null);
  });

  it("refuses a threshold, timeout or reviewer it cannot enforce", () => {
    // Correcting silently would enforce something other than what the operator
    // read back, and the direction of that mistake is an unreviewed spend.
    assert.throws(() => rule({ mode: "sometimes" as never }), /mode must be/);
    assert.throws(() => rule({ timeoutMs: 1_000 }), /timeoutMs must be/);
    assert.throws(() => rule({ threshold: { minSpend: "1.5" } }), /minSpend/);
    assert.throws(() => rule({ reviewer: { kind: "seat", account: "trader" } }), /address/);
  });

  it("resolves narrowest-first, and a crew rule may name the seat itself", () => {
    const rules = [
      rule({ scope: { level: "workspace" }, mode: "risky_writes" }),
      rule({ scope: { level: "crew", ref: MANAGER }, mode: "spends_and_writes" }),
      rule({ scope: { level: "agent", ref: PEER }, mode: "off" }),
    ];
    assert.equal(resolveDualControl(rules, { principal: WORKER, managers: [MANAGER] }).mode, "spends_and_writes");
    assert.equal(resolveDualControl(rules, { principal: PEER, managers: [MANAGER] }).mode, "off");
    assert.equal(resolveDualControl(rules, { principal: "0xdead" }).mode, "risky_writes");
    assert.equal(resolveDualControl([], {}).mode, "off");
  });
});

describe("what needs a second seat", () => {
  it("classifies the money path from the arguments the propose carries", () => {
    const spend = classifyDualEffect("lacrew_propose_intent", { value: "750000", target: "0xabc" });
    assert.deepEqual(spend, { effect: "spend", value: 750000n, target: "0xabc" });
    assert.deepEqual(classifyDualEffect("lacrew_org_action", {}), {
      effect: "write",
      surface: "org",
    });
    // Reads and the conversation tools carry no effect at all.
    assert.equal(classifyDualEffect("lacrew_say", { body: "hi" }), null);
    assert.equal(classifyDualEffect("lacrew_get_org", {}), null);
    // Approving is itself the second pair of eyes; reviewing a review would
    // stall the escalation path.
    assert.equal(classifyDualEffect("lacrew_approve_intent", {}), null);
  });

  it("treats an unclassifiable external surface as a write", () => {
    assert.deepEqual(classifyDualEffect("github.merge_pr", { pr: 7 }), {
      effect: "write",
      surface: "connector",
    });
    assert.equal(classifyDualEffect("github.list_prs", {}, () => "read"), null);
    assert.deepEqual(classifyDualEffect("mcp__linear__create_issue", {}), {
      effect: "write",
      surface: "connector",
    });
  });

  it("only reviews spends in spends_and_writes, and only above the threshold", () => {
    const writes = rule({ mode: "risky_writes" });
    const both = rule({ mode: "spends_and_writes", threshold: { minSpend: "1000000" } });
    const spend = (value: string) => classifyDualEffect("lacrew_propose_intent", { value })!;

    assert.equal(dualControlRequired(writes, spend("9999999999")), false);
    assert.equal(dualControlRequired(writes, classifyDualEffect("github.merge_pr", {})!), true);

    assert.equal(dualControlRequired(both, spend("999999")), false);
    assert.equal(dualControlRequired(both, spend("1000000")), true);
    assert.equal(dualControlRequired(both, spend("1000001")), true);

    // A value nobody can parse is reviewed whatever the floor: the alternative
    // is a propose escaping review because its amount was malformed.
    assert.equal(
      dualControlRequired(both, classifyDualEffect("lacrew_propose_intent", { value: "lots" })!),
      true,
    );

    assert.equal(dualControlRequired(rule({ mode: "off" }), spend("1")), false);
  });

  it("lets a threshold flag narrow which writes qualify", () => {
    const orgOnly = rule({ mode: "risky_writes", threshold: { connectorWrites: false } });
    assert.equal(dualControlRequired(orgOnly, classifyDualEffect("github.merge_pr", {})!), false);
    assert.equal(dualControlRequired(orgOnly, classifyDualEffect("lacrew_org_action", {})!), true);
  });
});

describe("who may concur", () => {
  it("routes to the nearest manager, and to the human above when it is one", () => {
    const target = resolveReviewer({ kind: "manager" }, WORKER, CHART);
    assert.deepEqual(target.accounts, [MANAGER]);
    assert.equal(target.human, false);
    assert.equal(target.escalated, false);

    const managersReviewer = resolveReviewer({ kind: "manager" }, MANAGER, CHART);
    assert.equal(managersReviewer.human, true);
    assert.deepEqual(managersReviewer.accounts, [HUMAN]);
  });

  it("walks past a paused or fired reviewer to a person, and says it escalated", () => {
    const chart = CHART.map((seat) =>
      seat.account === MANAGER ? { ...seat, paused: true } : seat,
    );
    const target = resolveReviewer({ kind: "manager" }, WORKER, chart);
    assert.equal(target.human, true);
    assert.deepEqual(target.accounts, [HUMAN]);
    assert.equal(target.escalated, true);

    const fired = CHART.map((seat) =>
      seat.account === MANAGER ? { ...seat, active: false } : seat,
    );
    assert.equal(resolveReviewer({ kind: "seat", account: MANAGER }, WORKER, fired).escalated, true);
  });

  it("never resolves the actor as its own reviewer", () => {
    // A misconfigured `seat:` naming the actor escalates to a person rather
    // than resolving to a set the actor is in.
    const target = resolveReviewer({ kind: "seat", account: WORKER }, WORKER, CHART);
    assert.equal(target.accounts.includes(WORKER), false);
    assert.equal(target.human, true);
    assert.equal(target.escalated, true);

    // And a crew of one has no peers, so `any_peer_in_crew` escalates too.
    const alone = resolveReviewer({ kind: "peer" }, MANAGER, CHART);
    assert.equal(alone.accounts.includes(MANAGER), false);
    assert.equal(alone.escalated, true);
  });

  it("offers every active peer under the same manager", () => {
    const target = resolveReviewer({ kind: "peer" }, WORKER, CHART);
    assert.deepEqual(target.accounts, [PEER]);
    assert.equal(target.human, false);
  });

  it("asks a person when the chart cannot be read", () => {
    const target = resolveReviewer({ kind: "manager" }, WORKER, []);
    assert.equal(target.human, true);
    assert.equal(target.escalated, true);
  });
});

describe("resolving a review", () => {
  it("reads only the offered words", () => {
    assert.equal(readReviewAnswer(" Concur "), "concurred");
    assert.equal(readReviewAnswer("reject."), "rejected");
    // A sentence a reviewer means as a yes and a parser can only guess at
    // decides nothing: a wrong guess is an effect nobody agreed to.
    assert.equal(readReviewAnswer("looks fine to me"), null);
    assert.equal(readReviewAnswer("yes"), null);
  });

  it("refuses the actor's own answer, however it is dressed up", () => {
    const target = resolveReviewer({ kind: "manager" }, WORKER, CHART);
    assert.equal(
      concurrenceQualifies(target, { author: WORKER, authorKind: "agent" }, WORKER),
      false,
    );
    // Including a seat that claims to be a person: attribution is made when the
    // message is posted, and the actor is refused before it is consulted.
    assert.equal(
      concurrenceQualifies(target, { author: WORKER.toUpperCase(), authorKind: "human" }, WORKER),
      false,
    );
    assert.equal(
      concurrenceQualifies(target, { author: MANAGER, authorKind: "agent" }, WORKER),
      true,
    );
  });

  it("refuses an agent nobody asked, and admits a person in its place", () => {
    const target = resolveReviewer({ kind: "seat", account: MANAGER }, WORKER, CHART);
    assert.equal(concurrenceQualifies(target, { author: PEER, authorKind: "agent" }, WORKER), false);
    // A crew whose reviewer agent is wedged must not be a crew that is frozen.
    assert.equal(
      concurrenceQualifies(target, { author: "ops@example.com", authorKind: "human" }, WORKER),
      true,
    );
  });

  it("lets no agent resolve a review addressed to people", () => {
    const target = resolveReviewer({ kind: "human" }, WORKER, CHART);
    assert.equal(
      concurrenceQualifies(target, { author: MANAGER, authorKind: "agent" }, WORKER),
      false,
    );
    assert.equal(
      concurrenceQualifies(target, { author: "ops@example.com", authorKind: "human" }, WORKER),
      true,
    );
  });
});
