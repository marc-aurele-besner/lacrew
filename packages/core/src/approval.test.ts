import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvalSeat } from "./approval.js";
import type { OrgNode } from "./types.js";

const ROOT = "0x1111111111111111111111111111111111111111" as const;
const MANAGER = "0x2222222222222222222222222222222222222222" as const;
const WORKER = "0x3333333333333333333333333333333333333333" as const;

function tree(over: { manager?: boolean | "removed"; worker?: boolean | "removed" } = {}) {
  const nodes: OrgNode[] = [{ account: ROOT, kind: "human_root", parent: null, active: true }];
  if (over.manager !== "removed") {
    nodes.push({
      account: MANAGER,
      kind: "manager_agent",
      parent: ROOT,
      active: over.manager ?? true,
    });
  }
  if (over.worker !== "removed") {
    nodes.push({
      account: WORKER,
      kind: "worker_agent",
      parent: over.manager === "removed" ? ROOT : MANAGER,
      active: over.worker ?? true,
    });
  }
  return nodes;
}

const intent = { agent: WORKER, awaitingApprover: MANAGER } as const;

describe("approvalSeat", () => {
  it("names the awaiting approver while it is an active node", () => {
    assert.deepEqual(approvalSeat(intent, tree()), {
      resolver: MANAGER,
      standIn: false,
      agentActive: true,
    });
  });

  it("compares addresses without regard to case", () => {
    const upper = MANAGER.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(approvalSeat({ agent: WORKER, awaitingApprover: upper }, tree()).standIn, false);
  });

  it("hands a deactivated approver's intent to the root", () => {
    assert.deepEqual(approvalSeat(intent, tree({ manager: false })), {
      resolver: ROOT,
      standIn: true,
      agentActive: true,
    });
  });

  it("hands a removed approver's intent to the root", () => {
    assert.deepEqual(approvalSeat(intent, tree({ manager: "removed" })), {
      resolver: ROOT,
      standIn: true,
      agentActive: true,
    });
  });

  it("gives the root no shortcut while the approver is active", () => {
    assert.equal(approvalSeat(intent, tree()).resolver, MANAGER);
  });

  it("reports an inactive or removed agent, whose intent can only be rejected", () => {
    assert.equal(approvalSeat(intent, tree({ worker: false })).agentActive, false);
    assert.equal(approvalSeat(intent, tree({ worker: "removed" })).agentActive, false);
  });

  it("names nobody for an intent that awaits nobody", () => {
    assert.deepEqual(approvalSeat({ agent: WORKER, awaitingApprover: null }, tree()), {
      resolver: null,
      standIn: false,
      agentActive: true,
    });
  });
});
