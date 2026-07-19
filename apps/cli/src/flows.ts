/**
 * `lacrew flows …` — author, inspect, and run agent logic flows (F1.17).
 * Talks to a running orchestrator (ORCH_URL / --url; token via ORCH_TOKEN),
 * with `--local` and `templates`/`code` working fully offline.
 */

import { readFileSync } from "node:fs";
import {
  createFlowsClient,
  createMockFlowBackend,
  flowRunSnippet,
  flowTemplates,
  flowToCode,
  getFlowTemplate,
  runFlow,
  validateFlow,
  type FlowDefinition,
  type FlowRunResult,
  type FlowStepTrace,
} from "@lacrew/flows";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function orchClient(args: string[]) {
  return createFlowsClient({
    baseUrl: flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788",
    token: process.env.ORCH_TOKEN?.trim() || undefined,
  });
}

/** Resolve a flow reference: template id, saved id (server-side), or JSON file path. */
function loadLocalDefinition(ref: string): FlowDefinition | undefined {
  const template = getFlowTemplate(ref);
  if (template) return template.definition;
  if (ref.endsWith(".json")) {
    const def = JSON.parse(readFileSync(ref, "utf8")) as FlowDefinition;
    return def;
  }
  return undefined;
}

const STEP_GLYPHS: Record<string, string> = {
  model: "✶",
  tool: "⌬",
  gate: "¤",
  branch: "⑂",
};

function printStep(trace: FlowStepTrace): void {
  const glyph = STEP_GLYPHS[trace.kind] ?? "·";
  const verdict = trace.verdict ? ` [${trace.verdict}]` : "";
  const line =
    trace.status === "error"
      ? `  ✗ ${glyph} ${trace.stepId}${verdict} — ${trace.error}`
      : `  ✓ ${glyph} ${trace.stepId}${verdict} — ${trace.summary ?? ""}`;
  console.log(`${line} (${trace.ms}ms)`);
}

function printRun(run: FlowRunResult): void {
  console.log(
    `${run.status === "completed" ? "●" : "✗"} ${run.flowId} · ${run.status}` +
      `${run.trigger && run.trigger !== "manual" ? ` · trigger=${run.trigger}` : ""}` +
      `${run.mocked ? " · mocked" : ""} · ${run.steps.length} steps · run ${run.runId}`,
  );
}

export async function cmdFlows(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "templates": {
      for (const t of flowTemplates) {
        const trigger = t.definition.trigger === "epoch" ? " · epoch-triggered" : "";
        console.log(`${t.definition.id}  (${t.category}${trigger})`);
        console.log(`  ${t.description}`);
      }
      console.log(`\nRun one:  lacrew flows run ${flowTemplates[0]!.definition.id} --local`);
      return;
    }

    case "list": {
      const flows = await orchClient(rest).list();
      if (flows.length === 0) {
        console.log("No saved flows. Save one: lacrew flows save <file.json>");
        return;
      }
      for (const f of flows) {
        console.log(
          `${f.id}  "${f.name}" · ${f.steps.length} steps` +
            `${f.trigger === "epoch" ? " · epoch-triggered" : ""}`,
        );
      }
      return;
    }

    case "save": {
      const file = rest.find((a) => !a.startsWith("-"));
      if (!file) {
        console.error("Usage: lacrew flows save <file.json> [--url <orch>]");
        process.exitCode = 1;
        return;
      }
      const def = JSON.parse(readFileSync(file, "utf8")) as FlowDefinition;
      const check = validateFlow(def);
      if (!check.ok) {
        console.error(`Invalid flow:\n  - ${check.errors.join("\n  - ")}`);
        process.exitCode = 1;
        return;
      }
      const saved = await orchClient(rest).save(def);
      console.log(`Saved "${saved.id}" (${saved.steps.length} steps) to the orchestrator.`);
      return;
    }

    case "run": {
      const ref = rest.find((a) => !a.startsWith("-"));
      if (!ref) {
        console.error("Usage: lacrew flows run <id|file.json> [--input text] [--local] [--url <orch>]");
        process.exitCode = 1;
        return;
      }
      const input = flagValue(rest, "--input");
      const local = rest.includes("--local");

      if (local) {
        const def = loadLocalDefinition(ref);
        if (!def) {
          console.error(`Not a template id or .json file: ${ref}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Running "${def.id}" on the detached mock backend…`);
        const run = await runFlow(def, createMockFlowBackend(), {
          input,
          mocked: true,
          onStep: printStep,
        });
        printRun(run);
        return;
      }

      const client = orchClient(rest);
      const localDef = ref.endsWith(".json") ? loadLocalDefinition(ref) : undefined;
      const run = localDef
        ? await client.runDefinition(localDef, { input })
        : await client.run(ref, { input });
      for (const step of run.steps) printStep(step);
      printRun(run);
      return;
    }

    case "runs": {
      const runs = await orchClient(rest).runs();
      if (runs.length === 0) {
        console.log("No runs yet.");
        return;
      }
      for (const run of runs.slice(0, 20)) printRun(run);
      return;
    }

    case "code": {
      const ref = rest.find((a) => !a.startsWith("-"));
      const def = ref ? loadLocalDefinition(ref) : undefined;
      if (!def) {
        console.error("Usage: lacrew flows code <templateId|file.json>");
        console.error(`Templates: ${flowTemplates.map((t) => t.definition.id).join(", ")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${flowToCode(def)}\n\n${flowRunSnippet(def)}`);
      return;
    }

    default:
      console.log(`lacrew flows — agent logic pipelines

Commands:
  flows templates                      List built-in flow templates (offline)
  flows list [--url <orch>]            List flows saved on the orchestrator
  flows save <file.json>               Validate + save a definition
  flows run <id|file.json>             Run via the orchestrator (live trace)
        [--input text] [--local]      --local runs on the mock backend offline
  flows runs                           Recent run traces (newest first)
  flows code <templateId|file.json>    Print the code-first @lacrew/flows snippet

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
  }
}
