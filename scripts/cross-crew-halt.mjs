#!/usr/bin/env node
/**
 * The cross-crew halt, driven end to end against a real chain (PRD F2.13).
 *
 *   pnpm cross-crew-halt
 *
 * `risk-watch` claims it can stop the desk seat trading a protocol it has just
 * flagged. That claim used to rest on a run input: an address a human pasted,
 * which nothing checked was the account anybody meant. This script proves the
 * replacement, which is that the account is *resolved* — from the seat the desk
 * crew actually hired, through the reference the blueprint declares.
 *
 * What is real here:
 *
 *  - **The chain.** Anvil, with the reference contracts deployed. The desk
 *    executor is hired through governance and holds an account the chain minted.
 *  - **The orchestrator.** Started as a child of this script and asserted to be
 *    `mode: onchain`. It is also what stores the seat bindings the reference
 *    resolves against — no plan file, no address on a command line.
 *  - **The deactivation.** A governance proposal on the deployed module, voted
 *    and executed, after which the chain itself reports the seat inactive.
 *
 * The one fake is a stand-in for api.coingecko.com and api.llama.fi, registered
 * through the real presets with `baseUrl` pointed at it: everything between the
 * flow step and the socket is the production path, and CI does not depend on
 * two public hosts being up.
 *
 * ## Why no model key is the interesting case
 *
 * Without one every completion is the orchestrator's stub, so the sweep's
 * assessment is unreadable — and `risk-sweep` routes an unreadable assessment
 * to the halt rather than past it, because a watch that fails open is not a
 * watch. That is the blueprint's own guardrail, and it is what lets this script
 * drive the deactivate path unattended.
 *
 * Flags:
 *   --keep-chain     reuse an Anvil already listening instead of starting one
 *   --keep-running   leave the stack up after the checks pass
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
/** A port of its own, so a `pnpm dev:stack` in another terminal is left alone. */
const ORCH_PORT = process.env.CROSS_CREW_PORT ?? "8801";
const ORCH = `http://127.0.0.1:${ORCH_PORT}`;

/** The watchdog, and the crew whose seat it may stop. */
const WATCH = "risk-watch";
const DESK = "defi-desk";
/** The crew instance the desk's seat is recorded under. */
const DESK_CREW = "crew-desk-1";

const children = [];
let shuttingDown = false;
let failures = 0;

const C = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };

function log(scope, line) {
  process.stdout.write(`${C.dim}[${scope}]${C.off} ${line}\n`);
}

function check(label, condition, detail = "") {
  const mark = condition ? `${C.ok}✓${C.off}` : `${C.bad}✗${C.off}`;
  if (!condition) failures += 1;
  process.stdout.write(`  ${mark} ${label}${detail ? ` ${C.dim}— ${detail}${C.off}` : ""}\n`);
  return condition;
}

/* ------------------------------------------------------------------ *
 * Process plumbing
 * ------------------------------------------------------------------ */

function spawnService(name, command, cmdArgs, env = {}) {
  const child = spawn(command, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream) =>
    stream.on("data", (chunk) =>
      chunk
        .toString()
        .split("\n")
        .forEach((l) => l.trim() && process.env.CROSS_CREW_VERBOSE && log(name, l)),
    );
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    log(name, `exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.unshift({ name, child });
  return child;
}

function run(name, command, cmdArgs, env = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, cmdArgs, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const pipe = (s) =>
      s.on("data", (c) => {
        tail = (tail + c.toString()).slice(-4000);
        if (process.env.CROSS_CREW_VERBOSE) process.stdout.write(c);
      });
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("exit", (code) =>
      code === 0 ? ok(tail) : fail(new Error(`${name} exited with ${code}\n${tail}`)),
    );
  });
}

async function waitFor(label, probe, { attempts = 90, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function rpcReady(url) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

/* ------------------------------------------------------------------ *
 * The one fake: stand-ins for the two public read APIs
 * ------------------------------------------------------------------ */

/**
 * Serves the three routes the sweep reads, in the shapes the real hosts return.
 *
 * Registered through the real presets, so route resolution, path templating and
 * the credential header are the production path. Nothing here is a write: the
 * sweep's only side effect is the org action, which is the point of the script.
 */
function startMarketStub() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    hits.push(`${req.method} ${url.pathname}`);
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/simple/price") return json({ "ethena-usde": { usd: 0.93 } });
    if (url.pathname.startsWith("/tvl/")) return json(1_900_000_000);
    if (url.pathname === "/v2/chains") return json([{ name: "Ethereum", tvl: 61_000_000_000 }]);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      children.unshift({ name: "market-stub", child: { kill: () => server.close() } });
      ok({ baseUrl: `http://127.0.0.1:${port}`, hits });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Orchestrator client
 * ------------------------------------------------------------------ */

async function orch(path, init = {}) {
  const res = await fetch(`${ORCH}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const mcp = (name, args_ = {}) =>
  orch("/mcp/call", { method: "POST", body: JSON.stringify({ name, arguments: args_ }) });

const result = (out) => out?.result ?? out ?? {};

/** Vote a proposal through and execute it. One human seat clears the quorum. */
async function carry(proposalId) {
  await mcp("lacrew_governance", { action: "vote", proposalId: String(proposalId), support: true });
  try {
    await mcp("lacrew_governance", { action: "execute", proposalId: String(proposalId) });
    return true;
  } catch (err) {
    log("governance", `proposal ${proposalId} not executed — ${err.message.slice(0, 120)}`);
    return false;
  }
}

/** Hire a seat and see it through to an account. */
async function hire(label, kind) {
  const before = new Set((await orch("/org")).nodes.map((n) => n.account.toLowerCase()));
  const out = result(await mcp("lacrew_org_action", { action: "hire", label, nodeKind: kind }));
  if (out.proposalId) await carry(out.proposalId);
  const fresh = (await orch("/org")).nodes.find((n) => !before.has(n.account.toLowerCase()));
  return fresh?.account ?? null;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  if (!existsSync(resolve(ROOT, ".env"))) {
    throw new Error("No .env — copy .env.example first (it ships working Anvil defaults).");
  }
  const flowsDist = resolve(ROOT, "packages/flows/dist/index.js");
  if (!existsSync(flowsDist)) {
    throw new Error("packages/flows is not built — run `pnpm --filter @lacrew/flows build` first.");
  }
  const {
    bindCrewFlow,
    crewChecklist,
    crewChecklistBlocker,
    getCrewBlueprint,
    getFlowTemplate,
    resolveExternalSeats,
    externalSeatRefusal,
  } = await import(flowsDist);

  const watch = getCrewBlueprint(WATCH);
  const desk = getCrewBlueprint(DESK);
  const ref = watch.externalSeats?.[0];
  if (!ref) throw new Error(`${WATCH} declares no external seat — nothing to prove`);
  const sweep = getFlowTemplate("risk-sweep").definition;
  log("path", `${watch.name} halts ${ref.crewBlueprintId}.${ref.roleId}`);

  const stub = await startMarketStub();
  log("stub", `coingecko + defillama stand-in on ${stub.baseUrl}`);

  if (!(await rpcReady(RPC))) {
    log("anvil", "starting");
    spawnService("anvil", "anvil", ["--host", "127.0.0.1"]);
    await waitFor("anvil", () => rpcReady(RPC));
  } else {
    log("anvil", `reusing the chain already listening on ${RPC}`);
  }

  log("deploy", "deploying the reference contracts");
  await run("deploy", "pnpm", [
    "--filter",
    "@lacrew/cli",
    "exec",
    "tsx",
    "src/index.ts",
    "deploy",
    "--anvil",
  ]);
  // The deploy rewrites @lacrew/core's baked address book; the orchestrator
  // resolves the built dist, so without this it boots on the previous one.
  await run("deploy", "pnpm", ["--filter", "@lacrew/core", "build"]);

  log("orchestrator", `starting on ${ORCH}`);
  spawnService("orchestrator", "pnpm", ["--filter", "@lacrew/orchestrator", "dev:once"], {
    PORT: ORCH_PORT,
    LACREW_CONNECTORS: JSON.stringify([
      {
        preset: "coingecko",
        baseUrl: `${stub.baseUrl}`,
        authMode: "token",
        tokenEnv: "CROSS_CREW_CG_KEY",
      },
      { preset: "defillama", baseUrl: `${stub.baseUrl}` },
    ]),
    CROSS_CREW_CG_KEY: "local-fixture-key",
    LACREW_ORCH_TOKEN: "",
  });
  await waitFor("orchestrator", async () => {
    try {
      return (await fetch(`${ORCH}/health`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  });

  console.log("\nRuntime");
  const health = await orch("/health");
  check(
    "the orchestrator is on a chain, not mocked",
    health.mode !== "mock" && health.mocked !== true,
    `mode=${health.mode} chainId=${health.chainId}`,
  );
  const modelLive = Boolean(health.model?.provider && health.model.provider !== "memory");
  log(
    "orchestrator",
    modelLive
      ? `model provider ${health.model.provider}`
      : "no model key — the assessment is unreadable, which the sweep routes to the halt",
  );

  /*
    What the checklist reads, in the same shape the CLI and the cloud pass it.
    `external` is the references nothing has bound — the answer that is about
    another crew, and the one a "missing address" line would send an operator
    looking for something to paste.
  */
  const facts = async (external) => {
    const [conn, fl, runs, msgs] = await Promise.all([
      orch("/connectors"),
      orch("/flows"),
      orch("/flows/runs"),
      orch(`/messages?limit=20&thread=${encodeURIComponent(`crew:${WATCH}`)}`),
    ]);
    return {
      seats: { total: watch.roles.length, withAccount: 1 },
      runtime: { live: health.mode !== "mock" && health.mocked !== true },
      model: { configured: modelLive },
      connectors: (conn.connectors ?? []).map((c) => ({ id: c.id, ready: c.auth?.ready === true })),
      installedFlows: (fl.flows ?? []).map((f) => f.id),
      blueprintFlows: watch.flows,
      runs: (runs.runs ?? []).length,
      threadMessages: (msgs.messages ?? []).length,
      sample: null,
      externalUnbound: external,
    };
  };
  const flowsStep = (steps) => steps.find((s) => s.id === "flows");
  const unboundLabels = (resolution) =>
    (watch.externalSeats ?? [])
      .filter((seat) => resolution.missing.includes(seat.id))
      .map((seat) => seat.label);

  console.log("\nBefore anything is bound");
  const empty = resolveExternalSeats(watch, (await orch("/crew/bindings")).bindings ?? []);
  check(
    "the reference resolves to nothing while no desk seat is recorded",
    empty.missing.includes(ref.id) && !empty.external[ref.id],
    externalSeatRefusal(ref, empty)?.slice(0, 120) ?? "",
  );
  let refusedInstall = null;
  try {
    bindCrewFlow(sweep, { roles: {}, targets: {}, external: empty.external });
  } catch (err) {
    refusedInstall = err.message;
  }
  check(
    "and the flow refuses to install rather than binding the halt to nothing",
    /unbound_crew_placeholders: external\.desk-executor/.test(refusedInstall ?? ""),
    refusedInstall ?? "it installed",
  );

  const blocked = crewChecklist(await facts(unboundLabels(empty)));
  check(
    "the checklist blocks the flows step and names the reference, not an address",
    flowsStep(blocked)?.state === "blocked" && flowsStep(blocked).detail.includes(ref.label),
    flowsStep(blocked)?.detail ?? "no flows step",
  );
  // Whether it is the *first* blocker depends on what else is outstanding —
  // with no model key the model step leads — so this asserts the reference is a
  // blocker at all, not the checklist's ordering.
  check(
    "and it is one the checklist would stop a run on",
    crewChecklistBlocker(blocked) !== null,
    crewChecklistBlocker(blocked)?.title ?? "",
  );

  console.log("\nSeats");
  const executorRole = desk.roles.find((r) => r.id === ref.roleId);
  const executor = await hire(executorRole.label, executorRole.kind);
  check(`hired the desk's ${executorRole.label}`, Boolean(executor), executor ?? "no account");
  const leadRole = watch.roles.find((r) => r.flows.includes("risk-sweep"));
  const lead = await hire(leadRole.label, leadRole.kind);
  check(`hired the watch's ${leadRole.label}`, Boolean(lead), lead ?? "no account");

  // Recorded against the *desk's* blueprint and crew, which is what makes it
  // answerable to a reference that names them. The watch's own seats go under
  // its own scope: two crews both having a seat is not two crews sharing one.
  await orch("/crew/bindings", {
    method: "PUT",
    body: JSON.stringify({
      blueprintId: DESK,
      crewId: DESK_CREW,
      roles: { [ref.roleId]: executor },
      labels: { [ref.roleId]: executorRole.label },
    }),
  });
  await orch("/crew/bindings", {
    method: "PUT",
    body: JSON.stringify({
      blueprintId: WATCH,
      roles: { [leadRole.id]: lead },
      labels: { [leadRole.id]: leadRole.label },
    }),
  });

  console.log("\nResolution");
  const recorded = (await orch("/crew/bindings")).bindings ?? [];
  const resolved = resolveExternalSeats(watch, recorded);
  check(
    "the reference resolves to the account the desk's hire minted",
    resolved.external[ref.id]?.toLowerCase() === executor.toLowerCase(),
    `${ref.id} → ${resolved.external[ref.id] ?? "unresolved"}`,
  );
  check(
    "and it came from the desk's own seat record, not from this script",
    resolved.bindings[0]?.blueprintId === DESK && resolved.bindings[0]?.crewId === DESK_CREW,
    JSON.stringify(resolved.bindings[0] ?? {}),
  );
  // The watch's own lead is recorded too, and it is not a candidate: a
  // reference that could bind to a seat of the crew declaring it would be a
  // watchdog with the authority to halt itself.
  check(
    "a seat from another scope cannot answer for it",
    resolveExternalSeats(
      watch,
      recorded.filter((b) => b.blueprintId !== DESK),
    ).missing.includes(ref.id),
  );

  console.log("\nFlows");
  const bound = bindCrewFlow(sweep, {
    roles: { [leadRole.id]: lead },
    targets: {},
    external: resolved.external,
  });
  const halt = bound.steps.find((s) => s.id === "halt-sibling");
  check(
    "the deactivate step names that account, with no address typed anywhere",
    halt.node.toLowerCase() === executor.toLowerCase(),
    halt.node,
  );
  await orch("/flows", { method: "POST", body: JSON.stringify({ flow: bound }) });
  check(
    "risk-sweep is installed against the real seat",
    ((await orch("/flows")).flows ?? []).some((f) => f.id === "risk-sweep"),
  );

  console.log("\nChecklist");
  const after = crewChecklist(await facts(unboundLabels(resolved)));
  check(
    "with the reference bound and the flow saved, the flows step reads done",
    flowsStep(after)?.state === "done",
    flowsStep(after)?.detail ?? "",
  );

  console.log("\nThe halt");
  const runOut = await orch("/flows/run", {
    method: "POST",
    body: JSON.stringify({
      id: "risk-sweep",
      input: JSON.stringify({ ids: "ethena-usde", protocol: "ethena" }),
      as: lead,
    }),
  });
  check(
    "the run was served by the runtime, not the mock backend",
    runOut.mocked !== true && runOut.source !== "mock",
  );
  check(
    "it read the peg and the protocol's TVL through the connectors",
    stub.hits.some((h) => h.startsWith("GET /simple/price")) &&
      stub.hits.some((h) => h.startsWith("GET /tvl/")),
    stub.hits.join(", "),
  );
  const haltStep = (runOut.steps ?? []).find((s) => s.stepId === "halt-sibling");
  check(
    "an unreadable assessment routed to the halt rather than an all-clear",
    Boolean(haltStep),
    (runOut.steps ?? []).map((s) => s.stepId).join(" → "),
  );
  const proposalId = haltStep?.output?.proposalId ?? haltStep?.output?.intentId;
  check(
    "deactivating another crew's seat is a governance proposal, not a direct write",
    Boolean(proposalId),
    JSON.stringify(haltStep?.output ?? {}).slice(0, 160),
  );

  if (proposalId) {
    await carry(String(proposalId));
    const node = (await orch("/org")).nodes.find(
      (n) => n.account.toLowerCase() === executor.toLowerCase(),
    );
    check(
      "once voted, the chain reports the desk's executor inactive",
      node?.active === false,
      JSON.stringify({ account: node?.account, active: node?.active }),
    );
    const others = (await orch("/org")).nodes.filter(
      (n) => n.account.toLowerCase() !== executor.toLowerCase(),
    );
    check(
      "and nobody else was stopped",
      others.every((n) => n.active !== false),
      others.map((n) => `${n.account.slice(0, 8)}:${n.active}`).join(" "),
    );
  }

  console.log(
    failures === 0
      ? `\n${C.ok}cross-crew halt: every check held.${C.off}`
      : `\n${C.bad}cross-crew halt: ${failures} check(s) failed.${C.off}`,
  );
  if (has("--keep-running") && failures === 0) {
    log("stack", `left up on ${ORCH} — ctrl-c to stop`);
    return;
  }
  shutdown(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${C.bad}cross-crew halt failed:${C.off} ${err.message}`);
  shutdown(1);
});
