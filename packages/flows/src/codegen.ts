import type { FlowDefinition, FlowStep } from "./types.js";

const str = (v: string): string => JSON.stringify(v);

function optsLiteral(pairs: Array<[string, unknown]>): string {
  const parts = pairs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? str(v) : JSON.stringify(v)}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

function stepCall(step: FlowStep): string {
  switch (step.kind) {
    case "model":
      return `.model(${str(step.id)}, ${optsLiteral([
        ["label", step.label],
        ["system", step.system],
        ["prompt", step.prompt],
        ["model", step.model],
        ["next", step.next],
      ])})`;
    case "tool": {
      const tail: string[] = [];
      const opts = optsLiteral([
        ["label", step.label],
        ["next", step.next],
      ]);
      if (step.args && Object.keys(step.args).length) tail.push(JSON.stringify(step.args));
      else if (opts !== "{}") tail.push("undefined");
      if (opts !== "{}") tail.push(opts);
      return `.tool(${[str(step.id), str(step.tool), ...tail].join(", ")})`;
    }
    case "gate":
      return `.gate(${str(step.id)}, ${optsLiteral([
        ["label", step.label],
        ["agent", step.agent],
        ["target", step.target],
        ["value", step.value],
        ["onAllow", step.onAllow],
        ["onEscalate", step.onEscalate],
        ["onDeny", step.onDeny],
      ])})`;
    case "branch":
      return `.branch(${str(step.id)}, ${optsLiteral([
        ["label", step.label],
        ["when", step.when],
        ["onTrue", step.onTrue],
        ["onFalse", step.onFalse],
      ])})`;
    case "switch":
      return `.switch(${str(step.id)}, ${optsLiteral([
        ["label", step.label],
        ["when", step.when],
        ["cases", step.cases],
        ["onDefault", step.onDefault],
      ])})`;
  }
}

function camel(id: string): string {
  const s = id.replace(/[-_\s]+(\w)/g, (_m, c: string) => c.toUpperCase()).replace(/[^\w]/g, "");
  return /^[a-zA-Z_]/.test(s) ? s : `flow${s}`;
}

/**
 * Render a definition back to the code-first builder API — the "expose the
 * logic" panel in the visual builder ships exactly this snippet.
 */
export function flowToCode(def: FlowDefinition): string {
  const name = camel(def.id);
  const lines: string[] = [
    `import { flow } from "@lacrew/flows";`,
    ``,
    `export const ${name} = flow(${str(def.id)}, ${str(def.name)})`,
  ];
  if (def.description) lines.push(`  .describe(${str(def.description)})`);
  if (def.trigger && def.trigger !== "manual") lines.push(`  .trigger(${str(def.trigger)})`);
  if (def.entry) lines.push(`  .entry(${str(def.entry)})`);
  for (const step of def.steps) lines.push(`  ${stepCall(step)}`);
  lines[lines.length - 1] += ";";
  return lines.join("\n");
}

/** Companion snippet: save + run the flow against a self-hosted orchestrator. */
export function flowRunSnippet(def: FlowDefinition): string {
  return [
    `import { createFlowsClient } from "@lacrew/flows";`,
    ``,
    `const flows = createFlowsClient({`,
    `  baseUrl: process.env.ORCH_URL ?? "http://127.0.0.1:8788",`,
    `  token: process.env.ORCH_TOKEN,`,
    `});`,
    ``,
    `await flows.save(${camel(def.id)});`,
    `const run = await flows.run(${str(def.id)}, { input: "manual run" });`,
    `console.log(run.status, run.steps.map((s) => s.summary));`,
  ].join("\n");
}
