import type {
  AgentStep,
  BranchStep,
  BudgetStep,
  FlowDefinition,
  FlowScope,
  FlowStep,
  GateStep,
  GovernanceStep,
  ModelStep,
  OrgStep,
  SwitchStep,
  ToolStep,
} from "./types.js";
import { validateFlow } from "./validate.js";

type StepOpts<T extends FlowStep> = Omit<T, "id" | "kind">;

/**
 * Code-first flow authoring:
 *
 *   const def = flow("treasury-pulse", "Morning treasury pulse")
 *     .tool("org", "lacrew_get_org_tree")
 *     .model("summary", { prompt: "Summarize: {{steps.org.json}}" })
 *     .gate("spend", { value: "75000000" })
 *     .build();
 *
 * Steps chain in declaration order unless a step sets explicit edges.
 * `build()` validates and throws on structural errors.
 */
export function flow(id: string, name?: string): FlowBuilder {
  return new FlowBuilder(id, name ?? id);
}

export class FlowBuilder {
  private def: FlowDefinition;

  constructor(id: string, name: string) {
    this.def = { id, name, steps: [] };
  }

  describe(description: string): this {
    this.def.description = description;
    return this;
  }

  entry(stepId: string): this {
    this.def.entry = stepId;
    return this;
  }

  /** "epoch" runs the flow automatically on every payroll epoch. */
  trigger(trigger: NonNullable<FlowDefinition["trigger"]>): this {
    this.def.trigger = trigger;
    return this;
  }

  /** 5-field UTC cron expression; required alongside the "cron" trigger. */
  schedule(schedule: string): this {
    this.def.schedule = schedule;
    return this;
  }

  source(source: FlowDefinition["source"]): this {
    this.def.source = source;
    return this;
  }

  /** Publish the flow to the whole org, one team subtree, or a single agent. */
  scope(
    level: FlowScope["level"],
    ref?: string,
    limits?: Pick<FlowScope, "window" | "rate">,
  ): this {
    this.def.scope = {
      level,
      ...(ref === undefined ? {} : { ref }),
      ...(limits?.window ? { window: limits.window } : {}),
      ...(limits?.rate ? { rate: limits.rate } : {}),
    };
    return this;
  }

  model(id: string, opts: StepOpts<ModelStep>): this {
    this.def.steps.push({ id, kind: "model", ...opts });
    return this;
  }

  tool(
    id: string,
    tool: string,
    args?: Record<string, unknown>,
    opts: Omit<StepOpts<ToolStep>, "tool" | "args"> = {},
  ): this {
    this.def.steps.push({ id, kind: "tool", tool, args, ...opts });
    return this;
  }

  gate(id: string, opts: StepOpts<GateStep>): this {
    this.def.steps.push({ id, kind: "gate", ...opts });
    return this;
  }

  branch(id: string, opts: StepOpts<BranchStep>): this {
    this.def.steps.push({ id, kind: "branch", ...opts });
    return this;
  }

  switch(id: string, opts: StepOpts<SwitchStep>): this {
    this.def.steps.push({ id, kind: "switch", ...opts });
    return this;
  }

  /** Delegate to another agent; the delegate runs under its own policy stack. */
  agent(id: string, opts: StepOpts<AgentStep>): this {
    this.def.steps.push({ id, kind: "agent", ...opts });
    return this;
  }

  /** Change the org chart or an agent's properties (ALLOW writes, ESCALATE proposes). */
  org(id: string, opts: StepOpts<OrgStep>): this {
    this.def.steps.push({ id, kind: "org", ...opts });
    return this;
  }

  /** Move allowances: raise a grant, stream one, or run the next epoch. */
  budget(id: string, opts: StepOpts<BudgetStep>): this {
    this.def.steps.push({ id, kind: "budget", ...opts });
    return this;
  }

  /** Vote, veto, execute, or raise a generic governance proposal. */
  governance(id: string, opts: StepOpts<GovernanceStep>): this {
    this.def.steps.push({ id, kind: "governance", ...opts });
    return this;
  }

  /** Raw escape hatch for steps built elsewhere (e.g. loaded JSON). */
  step(step: FlowStep): this {
    this.def.steps.push(step);
    return this;
  }

  toJSON(): FlowDefinition {
    return structuredClone(this.def);
  }

  build(): FlowDefinition {
    const def = this.toJSON();
    const result = validateFlow(def);
    if (!result.ok) {
      throw new Error(`Invalid flow "${def.id}": ${result.errors.join("; ")}`);
    }
    return def;
  }
}
