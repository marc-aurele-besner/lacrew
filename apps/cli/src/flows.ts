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
  type FlowTriggerRecord,
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

/** Mirrors KIND_META in the visual builder so traces read the same in both. */
const STEP_GLYPHS: Record<string, string> = {
  model: "✶",
  tool: "⌬",
  gate: "¤",
  branch: "⑂",
  switch: "⑂*",
  agent: "◈",
  org: "⚏",
  budget: "◲",
  governance: "⚖",
};

function printStep(trace: FlowStepTrace): void {
  const glyph = STEP_GLYPHS[trace.kind] ?? "·";
  const verdict = trace.verdict ? ` [${trace.verdict}]` : "";
  const line =
    trace.status === "error"
      ? `  ✗ ${glyph} ${trace.stepId}${verdict} — ${trace.error}`
      : // A step waiting on a human is not a step that failed, and reading it
        // as one would send an operator hunting a bug in a flow that is fine.
        trace.status === "waiting"
        ? `  … ${glyph} ${trace.stepId}${verdict} — ${trace.summary ?? "waiting"}`
        : `  ✓ ${glyph} ${trace.stepId}${verdict} — ${trace.summary ?? ""}`;
  console.log(`${line} (${trace.ms}ms)`);
}

function printRun(run: FlowRunResult): void {
  const glyph = run.status === "completed" ? "●" : run.status === "waiting" ? "…" : "✗";
  console.log(
    `${glyph} ${run.flowId} · ${run.status}` +
      `${run.trigger && run.trigger !== "manual" ? ` · trigger=${run.trigger}` : ""}` +
      `${run.mocked ? " · mocked" : ""} · ${run.steps.length} steps · run ${run.runId}`,
  );
  if (run.status === "waiting") {
    console.log(
      `  ${run.waiting?.detail ?? run.waiting?.reason ?? "waiting"}` +
        `${run.waiting?.token ? ` (${run.waiting.token})` : ""}`,
    );
    console.log("  Answer it:  lacrew connectors asks");
  }
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
      const as = flagValue(rest, "--as");
      const flows = await orchClient(rest).list(as ? { as } : undefined);
      if (flows.length === 0) {
        console.log(
          as
            ? `No flows scoped to ${as}.`
            : "No saved flows. Save one: lacrew flows save <file.json>",
        );
        return;
      }
      for (const f of flows) {
        const scope =
          f.scope && f.scope.level !== "org" ? ` · ${f.scope.level}:${f.scope.ref}` : "";
        console.log(
          `${f.id}  "${f.name}" · ${f.steps.length} steps` +
            `${f.trigger === "epoch" ? " · epoch-triggered" : ""}${scope}`,
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
        console.error(
          "Usage: lacrew flows run <id|file.json> [--input text] [--as 0x…] [--local] [--url <orch>]",
        );
        process.exitCode = 1;
        return;
      }
      const input = flagValue(rest, "--input");
      const as = flagValue(rest, "--as");
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
      try {
        const run = localDef
          ? await client.runDefinition(localDef, { input, as })
          : await client.run(ref, { input, as });
        for (const step of run.steps) printStep(step);
        printRun(run);
      } catch (err) {
        // The orchestrator's refusals are expected outcomes, not crashes.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("flow_out_of_scope")) {
          console.error(
            `"${ref}" is not in scope for ${as}. Check: lacrew flows list --as ${as}`,
          );
        } else if (msg.includes("flow_not_found")) {
          console.error(`No flow "${ref}" on the orchestrator. See: lacrew flows list`);
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
      }
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

    case "triggers": {
      await cmdTriggers(rest);
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
  flows list [--as 0x…]                List flows saved on the orchestrator;
                                       --as narrows to one agent's scope
  flows save <file.json>               Validate + save a definition
  flows run <id|file.json>             Run via the orchestrator (live trace)
        [--input text] [--local]      --local runs on the mock backend offline
        [--as 0x…]                    run as that agent; its policy applies,
                                       capped by the flow's scope
  flows runs                           Recent run traces (newest first)
  flows triggers <sub>                 Webhook triggers (F2.22) — see
                                       lacrew flows triggers for the subcommands
  flows code <templateId|file.json>    Print the code-first @lacrew/flows snippet

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
  }
}

/** Comma-separated `--events pull_request,push` into a list. */
function listValue(args: string[], flag: string): string[] | undefined {
  const raw = flagValue(args, flag);
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** `--field pr=pull_request.number` (repeatable) into an input field map. */
function fieldMap(args: string[]): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--field") continue;
    const pair = args[i + 1];
    if (!pair || pair.startsWith("-")) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function printTrigger(t: FlowTriggerRecord): void {
  const bits = [
    t.enabled ? "enabled" : "disabled",
    t.scheme,
    t.events?.length ? `events=${t.events.join(",")}` : "events=all",
    t.principal ? `as ${t.principal}` : "as crew default",
  ];
  console.log(`${t.id}  → ${t.flowId}  · ${bits.join(" · ")}`);
  if (t.description) console.log(`  ${t.description}`);
}

/**
 * `lacrew flows triggers …` — manage webhook triggers from the terminal so a
 * self-hosted operator never needs the cloud UI or a hand-rolled curl.
 */
async function cmdTriggers(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const client = () => orchClient(rest);

  switch (sub) {
    case "list": {
      const triggers = await client().listTriggers();
      if (triggers.length === 0) {
        console.log(
          "No webhook triggers. Create one: lacrew flows triggers create --flow <id>",
        );
        return;
      }
      for (const t of triggers) printTrigger(t);
      return;
    }

    case "create": {
      const flowId = flagValue(rest, "--flow");
      if (!flowId) {
        console.error(
          "Usage: lacrew flows triggers create --flow <flowId> [--source lacrew|github|google-pubsub]\n" +
            "         [--as 0x…] [--events a,b] [--path p] [--field k=path]…\n" +
            "         [--audience <aud> --service-account <email>]  (google-pubsub)",
        );
        process.exitCode = 1;
        return;
      }
      const fields = fieldMap(rest);
      const path = flagValue(rest, "--path");
      const audience = flagValue(rest, "--audience");
      const serviceAccountEmail = flagValue(rest, "--service-account");
      try {
        const made = await client().createTrigger({
          flowId,
          ...(flagValue(rest, "--source") ? { scheme: flagValue(rest, "--source")! } : {}),
          ...(flagValue(rest, "--as") ? { principal: flagValue(rest, "--as")! } : {}),
          ...(listValue(rest, "--events") ? { events: listValue(rest, "--events")! } : {}),
          ...(fields || path ? { input: { ...(path ? { path } : {}), ...(fields ? { fields } : {}) } } : {}),
          ...(flagValue(rest, "--description")
            ? { description: flagValue(rest, "--description")! }
            : {}),
          ...(audience || serviceAccountEmail
            ? {
                config: {
                  ...(audience ? { audience } : {}),
                  ...(serviceAccountEmail ? { serviceAccountEmail } : {}),
                },
              }
            : {}),
        });
        printTrigger(made.trigger);
        if (made.secret) {
          // Printed once, never readable again — say so where it is read, not
          // only in the docs an operator has already closed.
          console.log(`\nSigning secret (shown once, store it now):\n  ${made.secret}`);
          console.log(
            `\nDeliver to:  POST ${orchBase(rest)}/hooks/${made.trigger.id}\n` +
              "Signing:     see  lacrew flows triggers curl " +
              `${made.trigger.id}`,
          );
        } else {
          console.log(
            `\nThis source authenticates its sender, so there is no secret.\n` +
              `Point the push subscription at:  ${orchBase(rest)}/hooks/${made.trigger.id}`,
          );
        }
      } catch (err) {
        console.error(triggerError(err));
        process.exitCode = 1;
      }
      return;
    }

    case "rotate": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: lacrew flows triggers rotate <triggerId>");
        process.exitCode = 1;
        return;
      }
      try {
        const made = await client().rotateTriggerSecret(id);
        console.log(
          `Rotated ${made.trigger.id} (version ${made.trigger.secretVersion}). ` +
            "The previous secret no longer verifies.",
        );
        if (made.secret) console.log(`\nNew secret (shown once):\n  ${made.secret}`);
      } catch (err) {
        console.error(triggerError(err));
        process.exitCode = 1;
      }
      return;
    }

    case "enable":
    case "disable": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error(`Usage: lacrew flows triggers ${sub} <triggerId>`);
        process.exitCode = 1;
        return;
      }
      try {
        const t = await client().setTriggerEnabled(id, sub === "enable");
        printTrigger(t);
      } catch (err) {
        console.error(triggerError(err));
        process.exitCode = 1;
      }
      return;
    }

    case "delete": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: lacrew flows triggers delete <triggerId>");
        process.exitCode = 1;
        return;
      }
      const removed = await client().removeTrigger(id);
      console.log(removed ? `Removed ${id}.` : `No trigger ${id}.`);
      if (!removed) process.exitCode = 1;
      return;
    }

    case "deliveries": {
      const id = rest.find((a) => !a.startsWith("-"));
      const limit = Number(flagValue(rest, "--limit") ?? 20);
      const deliveries = await client().triggerDeliveries({
        ...(id ? { triggerId: id } : {}),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
      });
      if (deliveries.length === 0) {
        console.log("No deliveries recorded.");
        return;
      }
      for (const d of deliveries) {
        const mark = d.result === "run_started" ? "●" : d.result === "rejected" ? "✗" : "·";
        console.log(
          `${mark} ${d.at}  ${d.result}` +
            `${d.reason ? ` — ${d.reason}` : ""}` +
            `${d.runId ? ` · run ${d.runId}` : ""}` +
            `${d.bytes != null ? ` · ${d.bytes}b` : ""}`,
        );
      }
      return;
    }

    case "curl": {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) {
        console.error("Usage: lacrew flows triggers curl <triggerId>");
        process.exitCode = 1;
        return;
      }
      // A runnable example beats prose: the signature covers the exact bytes
      // sent, which is the one thing operators get wrong.
      console.log(`# Signed delivery for ${id} (lacrew scheme).
# SECRET is the value shown once at create/rotate time.
BODY='{"pull_request":{"number":7,"title":"Add hooks"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -X POST ${orchBase(rest)}/hooks/${id} \\
  -H 'content-type: application/json' \\
  -H "X-Lacrew-Timestamp: $TS" \\
  -H "X-Lacrew-Signature: sha256=$SIG" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d "$BODY"`);
      return;
    }

    default:
      console.log(`lacrew flows triggers — webhook triggers (F2.22)

Commands:
  triggers list                        Registered triggers (never the secret)
  triggers create --flow <id>          Mint one; prints the secret exactly once
        [--source lacrew|github|google-pubsub]
        [--as 0x…]                     principal the run executes as
        [--events pull_request,push]   only these event types (default: all)
        [--path a.b | --field k=a.b]…  map the body into the flow's input
        [--audience <aud>]             google-pubsub: subscription audience
        [--service-account <email>]    google-pubsub: pushing service account
  triggers rotate <id>                 New secret; the old one stops verifying
  triggers enable|disable <id>         Toggle without deleting
  triggers delete <id>                 Remove it
  triggers deliveries [id] [--limit n] Delivery log with reason codes
  triggers curl <id>                   Print a signed-delivery example

Env:
  ORCH_URL     Orchestrator base URL (default http://127.0.0.1:8788)
  ORCH_TOKEN   Bearer token (pairs with LACREW_ORCH_TOKEN)`);
  }
}

function orchBase(args: string[]): string {
  return (
    flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788"
  ).replace(/\/$/, "");
}

/** Turn the orchestrator's refusal codes into something an operator can act on. */
export function triggerError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("flow_not_webhook_triggered")) {
    return 'That flow does not declare trigger: "webhook". Add it to the definition and save again — a hook cannot make a flow externally startable on its own.';
  }
  if (msg.includes("flow_not_found")) return "No such flow on the orchestrator. See: lacrew flows list";
  if (msg.includes("webhook_trigger_not_found")) return "No such trigger. See: lacrew flows triggers list";
  if (msg.includes("source_config_required")) {
    return "This source needs --audience and --service-account before it can verify anything.";
  }
  if (msg.includes("source_has_no_secret")) {
    return "This source authenticates its sender rather than sharing a secret, so there is nothing to rotate.";
  }
  if (msg.includes("webhook_sealing_unavailable")) {
    return "The orchestrator has a database but no LACREW_SESSION_KEY, so a trigger secret cannot be sealed at rest. Generate one with: openssl rand -base64 32";
  }
  return msg;
}
