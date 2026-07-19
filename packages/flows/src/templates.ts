import { flow } from "./builder.js";
import type { FlowTemplate } from "./types.js";

/**
 * First-party flow templates. These seed the visual builder's gallery and the
 * (mocked, Phase 3) marketplace catalog. Values are USDC 6dp decimal strings
 * matching the demo org; agent/target defaults come from the executing runtime.
 */
export const flowTemplates: FlowTemplate[] = [
  {
    id: "tpl-treasury-pulse",
    name: "Treasury pulse",
    description:
      "Read the org tree and pending escalations, then write a short treasury status update.",
    category: "treasury",
    author: "LaCrew",
    definition: flow("treasury-pulse", "Treasury pulse")
      .describe("Crew + escalation summary for the human root, refreshed every payroll epoch.")
      .trigger("epoch")
      .source({ templateId: "tpl-treasury-pulse", author: "LaCrew" })
      .tool("org", "lacrew_get_org_tree", undefined, { label: "Read org tree" })
      .tool("pending", "lacrew_list_pending_intents", undefined, {
        label: "List pending escalations",
      })
      .model("summary", {
        label: "Write the pulse",
        system: "You are the operations agent of a LaCrew organization.",
        prompt:
          "Org tree: {{steps.org.json}}\nPending escalations: {{steps.pending.json}}\n\nWrite a 3-sentence treasury pulse for the human root: crew shape, anything awaiting approval, and one recommended action.",
      })
      .build(),
  },
  {
    id: "tpl-budget-guarded-spend",
    name: "Budget-guarded spend",
    description:
      "Propose a spend through the policy stack: under-cap executes, over-cap escalates and drafts a purchase-order note.",
    category: "treasury",
    author: "LaCrew",
    definition: flow("budget-guarded-spend", "Budget-guarded spend")
      .describe("The escalation loop as a pipeline: ALLOW confirms, ESCALATE explains itself.")
      .source({ templateId: "tpl-budget-guarded-spend", author: "LaCrew" })
      .gate("spend", {
        label: "Propose 75 USDC spend",
        value: "75000000",
        onAllow: "confirm",
        onEscalate: "po-note",
        onDeny: null,
      })
      .model("confirm", {
        label: "Confirm receipt",
        prompt:
          "The spend was allowed under policy: {{steps.spend.json}}. Write a one-line receipt note for the audit trail.",
        next: null,
      })
      .model("po-note", {
        label: "Draft purchase-order note",
        prompt:
          "The spend escalated to the manager: {{steps.spend.json}}. Draft a 2-sentence purchase-order justification the approver will read.",
        next: null,
      })
      .build(),
  },
  {
    id: "tpl-escalation-triage",
    name: "Escalation triage",
    description:
      "Review pending escalations, recommend a decision, and approve automatically only when the model says APPROVE.",
    category: "escalation",
    author: "LaCrew",
    definition: flow("escalation-triage", "Escalation triage")
      .describe("Automated review seat: triage pending intents, act on a clear APPROVE.")
      .source({ templateId: "tpl-escalation-triage", author: "LaCrew" })
      .tool("pending", "lacrew_list_pending_intents", undefined, {
        label: "List pending escalations",
      })
      .model("triage", {
        label: "Triage the queue",
        system:
          "You are a risk-reviewer agent. Answer with APPROVE <intentId> or HOLD plus one reason line.",
        prompt: "Pending escalations: {{steps.pending.json}}",
      })
      .branch("clear", {
        label: "Clear approval?",
        when: { source: "{{steps.triage.text}}", op: "contains", value: "APPROVE mock-intent-1" },
        onTrue: "approve",
        onFalse: null,
      })
      .tool(
        "approve",
        "lacrew_approve_intent",
        { intentId: "mock-intent-1", approved: true },
        { label: "Approve intent", next: null },
      )
      .build(),
  },
  {
    id: "tpl-content-daily",
    name: "Content crew daily",
    description:
      "Ideate, draft, then pay for publishing through the budget gate — the web2 task with the enforceable wallet.",
    category: "content",
    author: "LaCrew",
    definition: flow("content-daily", "Content crew daily")
      .describe("Off-chain work, onchain budget: the publish fee rides the policy stack.")
      .source({ templateId: "tpl-content-daily", author: "LaCrew" })
      .model("ideate", {
        label: "Pick today's angle",
        system: "You are the content crew's planner agent.",
        prompt:
          "Topic hint: {{input}}. Propose one article angle (a headline + one sentence) about AI agent treasuries.",
      })
      .model("draft", {
        label: "Write the outline",
        prompt: "Write a 5-bullet outline for: {{steps.ideate.text}}",
      })
      .gate("publish-fee", {
        label: "Pay 25 USDC publish fee",
        value: "25000000",
        onEscalate: "note",
      })
      .model("done", {
        label: "Wrap up",
        prompt: "Publish paid ({{steps.publish-fee.json}}). Write a one-line completion note.",
        next: null,
      })
      .model("note", {
        label: "Explain the overage",
        prompt:
          "The publish fee escalated: {{steps.publish-fee.json}}. Write one sentence telling the manager why it is worth approving.",
        next: null,
      })
      .build(),
  },
];

export function getFlowTemplate(id: string): FlowTemplate | undefined {
  return flowTemplates.find((t) => t.id === id || t.definition.id === id);
}
