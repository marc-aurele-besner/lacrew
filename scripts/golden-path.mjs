#!/usr/bin/env node
/**
 * A certified golden path, driven end to end against a real chain.
 *
 *   pnpm golden-path                              # github-experts
 *   pnpm golden-path --blueprint content-studio   # the second certified path
 *
 * Everything the first-run checklist claims is derived from a probe, and every
 * probe in the test suites is a fixture. That is the right trade for a unit
 * test and the wrong one for a claim about whether the product works: a
 * checklist that clears against canned JSON has proved that the derivation is
 * correct, not that a crew can do anything. This script removes the fixtures.
 *
 * What is real here:
 *
 *  - **The chain.** Anvil, with the reference contracts deployed by
 *    `DeployMockOrg`. Hires are governance proposals that are voted and
 *    executed onchain, and the addresses the flows bind to are the ones those
 *    hires minted.
 *  - **The orchestrator.** Started as a child of this script and asserted to be
 *    `mode: onchain` before anything else runs. Nothing stubs its health; if it
 *    comes up in mock mode the script fails rather than reporting a green path
 *    against fabricated data.
 *  - **The connector**, for a path that has one. The `github` preset,
 *    registered exactly as an operator would register it, pointed at a local
 *    stand-in for api.github.com instead of the real host. The stand-in is the
 *    one fake, and it is the right one: the alternative is a token, a network
 *    round trip, and a public write path in CI.
 *  - **The policy verdict.** `lacrew_check_policy` is asked about the address
 *    the flow's write path would spend against, which nothing has admitted, and
 *    the DENY comes off the deployed policy stack.
 *
 * ## Two paths, deliberately different shapes
 *
 * `github-experts` needs a connector and a credential before its run means
 * anything. `content-studio` calls nothing outside LaCrew — its whole pipeline
 * is model work against a brief, and the write it could attempt is a
 * publication its own blueprint leaves off the whitelist. So it drives the
 * checklist branch the first path never reaches: the connector step answered
 * *not needed* rather than blocked. Certifying two GitHub-shaped verticals
 * would leave that answer unproved on the surface operators read.
 *
 * Which seats to hire and which targets to bind are read off the sample flow's
 * own `{{crew.*}}` / `{{target.*}}` placeholders, so a template that gains a
 * delegate gains the hire here in the same commit.
 *
 * What is optional: a model key. Without one the run's completions come back as
 * the orchestrator's stub, so the checklist correctly *blocks on the model*,
 * and this script asserts that refusal rather than pretending. Set any provider
 * key (e.g. `OPENROUTER_API_KEY`) and it asserts the whole path clears and the
 * sample run lands a message in the thread instead.
 *
 * Flags:
 *   --blueprint <id>  which certified path to drive (default github-experts)
 *   --keep-chain      reuse an Anvil already listening instead of starting one
 *   --keep-running    leave the stack up after the checks pass (for poking at it)
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : undefined;
};

if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
/** A port of its own, so a `pnpm dev:stack` in another terminal is left alone. */
const ORCH_PORT = process.env.GOLDEN_PATH_PORT ?? "8799";
const ORCH = `http://127.0.0.1:${ORCH_PORT}`;
const TOKEN_ENV = "GOLDEN_PATH_GH_TOKEN";
const BLUEPRINT = flagValue("--blueprint") ?? "github-experts";

/**
 * Addresses nothing has admitted to the whitelist.
 *
 * A fresh deployment admits nothing, so every one of these reads DENY off the
 * policy stack — which is the state the golden path is about. The flow's write
 * path asks about one of them before it writes, and the script asserts that
 * refusal rather than arranging for it not to happen. Named ones keep the
 * constants the fixtures and docs already use; a target a template adds later
 * gets a deterministic filler rather than stopping the driver.
 *
 * Every one is EIP-55 checksummed, and the filler is all digits so it cannot
 * fail to be: `lacrew_check_policy` parses these as addresses, and a wrong-case
 * hex nibble comes back a 500 rather than a verdict.
 */
const NAMED_TARGETS = {
  "merge-authority": "0x000000000000000000000000000000000000dEaD",
  "model-api": "0x000000000000000000000000000000000000bEEF",
  "publish-endpoint": "0x000000000000000000000000000000000000FEeD",
};
const targetAddress = (id, i) => NAMED_TARGETS[id] ?? `0x${String(i + 1).padStart(40, "0")}`;

/**
 * What a certified path needs that cannot be read off the blueprint or the flow.
 *
 * `refuses` is the target the run's write path asks policy about — the one the
 * whole path exists to show being refused. `connector` is present only for a
 * path that leaves LaCrew, and `policyTargets` maps each of that preset's write
 * routes to the blueprint target its spend is checked against: the preset
 * refuses to build with any of them unbound, on the grounds that a write route
 * whose authority nobody named is one nothing can refuse. The addresses come
 * from the same derived map the flow is bound with, so a route and a step
 * cannot end up pointed at two different accounts.
 */
const PROFILES = {
  "github-experts": {
    refuses: "merge-authority",
    connector: "github",
    policyTargets: {
      merge_pull_request: "merge-authority",
      create_issue_comment: "comment-authority",
    },
  },
  "content-studio": { refuses: "publish-endpoint" },
};

const children = [];
let shuttingDown = false;
let failures = 0;

const C = { ok: "\x1b[32m", bad: "\x1b[31m", dim: "\x1b[2m", off: "\x1b[0m" };

function log(scope, line) {
  process.stdout.write(`${C.dim}[${scope}]${C.off} ${line}\n`);
}

function check(label, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  ${C.ok}✓${C.off} ${label}${detail ? ` ${C.dim}— ${detail}${C.off}` : ""}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`  ${C.bad}✗${C.off} ${label}${detail ? ` ${C.dim}— ${detail}${C.off}` : ""}\n`);
  return false;
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
        .forEach((l) => l.trim() && process.env.GOLDEN_PATH_VERBOSE && log(name, l)),
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
        if (process.env.GOLDEN_PATH_VERBOSE) process.stdout.write(c);
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
 * The one fake: a stand-in for api.github.com
 * ------------------------------------------------------------------ */

/**
 * Serves the two routes the crew's triage flow calls, and records every hit.
 *
 * Registered through the real `github` preset with `baseUrl` pointed here, so
 * everything between the flow step and the socket — route resolution, path
 * templating, the credential header — is the production path. The merge route
 * exists so that a run which somehow reached it would be *visible*: on a crew
 * with no admitted merge authority nothing should ever call it, and a silent
 * 404 would hide the one failure that matters.
 */
function startGithubStub() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    hits.push(`${req.method} ${url.pathname}`);
    const pr = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && pr) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          number: Number(pr[3]),
          title: "chore(deps): bump viem from 2.21.0 to 2.21.1",
          user: { login: "renovate[bot]", type: "Bot" },
          merged: true,
          mergeable_state: "clean",
          base: { ref: "main" },
          head: { ref: "renovate/viem", sha: "0".repeat(40) },
          labels: [{ name: "dependencies" }],
        }),
      );
      return;
    }
    if (req.method === "PUT" && /\/merge$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ merged: true, message: "the stub should never be asked this" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      children.unshift({ name: "github-stub", child: { kill: () => server.close() } });
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

/**
 * Hire a seat and see it through to an account.
 *
 * A hire is a governance proposal, so the address only exists once the proposal
 * carries and executes. The root's own weight clears the quorum on a workspace
 * with one human seat, which is exactly the case here.
 */
async function hire(label, kind, parent) {
  const before = new Set((await orch("/org")).nodes.map((n) => n.account.toLowerCase()));
  const out = await mcp("lacrew_org_action", {
    action: "hire",
    label,
    nodeKind: kind,
    ...(parent ? { parent } : {}),
  });
  const proposalId = out?.result?.proposalId ?? out?.proposalId;
  if (proposalId) {
    await mcp("lacrew_governance", { action: "vote", proposalId: String(proposalId), support: true });
    try {
      await mcp("lacrew_governance", { action: "execute", proposalId: String(proposalId) });
    } catch (err) {
      // A high-tier hire waits out a timelock; the script says so rather than
      // failing, and the seat is reported missing by the checklist below.
      log("hire", `${label}: execute deferred — ${err.message.slice(0, 120)}`);
    }
  }
  const after = (await orch("/org")).nodes;
  const fresh = after.find((n) => !before.has(n.account.toLowerCase()));
  return fresh?.account ?? null;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  if (!existsSync(resolve(ROOT, ".env"))) {
    throw new Error("No .env — copy .env.example first (it ships working Anvil defaults).");
  }

  // The built package, by path: this script is not a workspace member, so the
  // bare specifier does not resolve from the repo root.
  const flowsDist = resolve(ROOT, "packages/flows/dist/index.js");
  if (!existsSync(flowsDist)) {
    throw new Error("packages/flows is not built — run `pnpm --filter @lacrew/flows build` first.");
  }
  const {
    getCrewBlueprint,
    bindCrewFlow,
    crewFlowOwner,
    crewFlowPlaceholders,
    crewSampleInputText,
    crewSampleNeeds,
    getFlowTemplate,
    crewSampleRun,
    crewChecklist,
    crewChecklistBlocker,
    resolveCrewSeats,
  } = await import(flowsDist);
  const bp = getCrewBlueprint(BLUEPRINT);
  const sample = crewSampleRun(BLUEPRINT);
  if (!bp || !sample) throw new Error(`${BLUEPRINT} has no blueprint or no certified sample`);
  const profile = PROFILES[BLUEPRINT];
  if (!profile) {
    throw new Error(
      `no driver profile for "${BLUEPRINT}" — certified paths: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  log("path", `${bp.name} — ${sample.flow}`);

  /*
    Read off the sample flow itself rather than listed here: a template that
    gains a delegate gains the hire, and one that gains a spend target gains the
    binding, in the same commit that added the step.
  */
  const sampleDef = getFlowTemplate(sample.flow).definition;
  const placeholders = crewFlowPlaceholders(sampleDef);
  const owner = crewFlowOwner(bp, sample.flow);
  const needs = crewSampleNeeds(sample);
  const wanted = [
    ...(owner ? [owner.id] : []),
    ...placeholders.filter((p) => p.startsWith("crew.")).map((p) => p.slice("crew.".length)),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const targets = Object.fromEntries(
    placeholders
      .filter((p) => p.startsWith("target."))
      .map((p) => p.slice("target.".length))
      .map((id, i) => [id, targetAddress(id, i)]),
  );

  const stub = profile.connector ? await startGithubStub() : null;
  if (stub) log("stub", `api.github.com stand-in on ${stub.baseUrl}`);

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
    // Registered the way an operator registers it: the real preset, the
    // operator's own host, the operator's own credential env var. A path whose
    // run never leaves LaCrew registers nothing — wiring a connector it does
    // not call would hide the checklist answer it exists to prove.
    LACREW_CONNECTORS: JSON.stringify(
      stub
        ? [
            {
              preset: profile.connector,
              baseUrl: stub.baseUrl,
              authMode: "token",
              tokenEnv: TOKEN_ENV,
              policyTargets: Object.fromEntries(
                Object.entries(profile.policyTargets ?? {}).map(([route, target]) => [
                  route,
                  targets[target] ?? targetAddress(target, 0),
                ]),
              ),
            },
          ]
        : [],
    ),
    [TOKEN_ENV]: "local-fixture-token",
    // The hires below are governance proposals; without this each one waits for
    // a hand to press Execute and the script cannot finish unattended.
    LACREW_AUTO_EXECUTE: "1",
    // A bearer token would have to be threaded through every call here for no
    // gain: nothing outside this process can reach the port.
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
  log("orchestrator", modelLive ? `model provider ${health.model.provider}` : "no model key — completions return the local stub");

  console.log("\nConnector");
  if (profile.connector) {
    const connectors = await orch("/connectors");
    const registered = (connectors.connectors ?? []).find((c) => c.id === profile.connector);
    check(`the ${profile.connector} connector is registered`, Boolean(registered));
    // Presence only — the registry reports whether the env var is set, never
    // what is in it.
    check("its credential resolves", registered?.auth?.ready === true, `${TOKEN_ENV} is set`);
  } else {
    check(
      "this path needs no connector, and the flow's own steps say so",
      needs.connectors.length === 0,
      needs.connectors.join(", ") || "no connector routes in the sample flow",
    );
  }

  console.log("\nSeats");
  /*
    Only the seats the sample's own flow names — its owning principal and every
    delegate it invokes. Hiring the whole blueprint would spend a proposal per
    seat to prove nothing these do not: a flow binds the principals it
    references, and the checklist counts the rest as still-pending hires.
  */
  const roleAccounts = {};
  for (const roleId of wanted) {
    const role = bp.roles.find((r) => r.id === roleId);
    const account = await hire(role.label, role.kind, undefined);
    if (account) roleAccounts[roleId] = account;
    check(`hired ${role.label}`, Boolean(account), account ?? "no account minted");
  }

  /*
    The rename, done for real. The seat keeps its account, its policy stack and
    its reporting line; only the string a human reads changes. Everything after
    this point resolves it through the stored role id — which is the whole point
    of storing one.
  */
  const [renamedRole, unrenamedRole] = wanted;
  const renamed = `${bp.roles.find((r) => r.id === renamedRole).label} (renamed)`;
  /*
    The chain stores no labels, so the display name and the role id are both
    control-plane state layered over the served node — which is exactly the
    layering `nodeLabels` already does in the cloud and the reason a role id
    belongs beside it. Every hired seat carries its id; only the first seat's
    label is changed, and the second is left alone as the control.
  */
  const orgNodes = (await orch("/org")).nodes.map((n) => {
    const roleId = Object.keys(roleAccounts).find(
      (r) => roleAccounts[r].toLowerCase() === n.account.toLowerCase(),
    );
    if (!roleId) return n;
    const role = bp.roles.find((r) => r.id === roleId);
    return { ...n, roleId, label: roleId === renamedRole ? renamed : role.label };
  });
  const seats = resolveCrewSeats(bp, orgNodes);
  check(
    "a renamed seat still resolves through its stored role id",
    seats.roles[renamedRole]?.toLowerCase() === roleAccounts[renamedRole]?.toLowerCase(),
    `${renamed} → ${seats.roles[renamedRole] ?? "unresolved"}`,
  );
  check(
    "and the resolution says the label no longer matches",
    seats.renamed.some((b) => b.role === renamedRole),
  );
  const withoutRoleIds = resolveCrewSeats(
    bp,
    orgNodes.map(({ roleId: _drop, ...rest }) => rest),
  );
  check(
    "without the stored id the same seat is reported missing, never guessed",
    withoutRoleIds.missing.includes(renamedRole) && !withoutRoleIds.roles[renamedRole],
  );
  check(
    "while a seat nobody renamed still binds by label alone",
    withoutRoleIds.roles[unrenamedRole]?.toLowerCase() ===
      roleAccounts[unrenamedRole]?.toLowerCase(),
  );

  console.log("\nEnforcement");
  const refusedTarget = targets[profile.refuses];
  const verdict = await mcp("lacrew_check_policy", {
    agent: seats.roles[wanted[0]],
    target: refusedTarget,
    value: "0",
  });
  const verdictText = JSON.stringify(verdict);
  check(
    `the unadmitted ${profile.refuses} reads DENY off the deployed policy stack`,
    /DENY|ESCALATE/.test(verdictText),
    verdictText.slice(0, 160),
  );

  console.log("\nFlows");
  const bound = bindCrewFlow(sampleDef, {
    roles: { ...seats.roles },
    targets,
  });
  await orch("/flows", { method: "POST", body: JSON.stringify({ flow: bound }) });
  const saved = await orch("/flows");
  check(
    `${sample.flow} is installed against real seat addresses`,
    (saved.flows ?? []).some((f) => f.id === sample.flow),
  );

  console.log("\nChecklist");
  const thread = `crew:${BLUEPRINT}`;
  const facts = async () => {
    const [h, conn, fl, runs, msgs] = await Promise.all([
      orch("/health"),
      orch("/connectors"),
      orch("/flows"),
      orch("/flows/runs"),
      orch(`/messages?limit=20&thread=${encodeURIComponent(thread)}`),
    ]);
    return {
      seats: { total: wanted.length, withAccount: Object.keys(seats.roles).filter((r) => r !== "root").length },
      runtime: { live: h.mode !== "mock" && h.mocked !== true },
      model: { configured: Boolean(h.model?.provider && h.model.provider !== "memory") },
      connectors: (conn.connectors ?? []).map((c) => ({ id: c.id, ready: c.auth?.ready === true })),
      installedFlows: (fl.flows ?? []).map((f) => f.id),
      // Only the sample's own flow: the script installs one, so asserting all
      // three would fail on work it deliberately did not do.
      blueprintFlows: [sample.flow],
      runs: (runs.runs ?? []).length,
      threadMessages: (msgs.messages ?? []).length,
      // The flow's own requirements, not a repeat of them: a path that calls
      // nothing outside LaCrew has to reach the checklist's *not needed*
      // answer, and a hardcoded connector list here would hide that.
      sample: { flow: sample.flow, needs },
    };
  };

  const before = crewChecklist(await facts());
  const blocker = crewChecklistBlocker(before);
  for (const step of before) {
    log("checklist", `${step.state.padEnd(8)} ${step.title} — ${step.detail}`);
  }
  /*
    The branch the second certified path exists to drive. A run that calls
    nothing outside LaCrew must not send an operator to register a credential,
    and "not needed" is a different answer from "wired" — one a suite of
    connector-shaped verticals never reaches.
  */
  if (!profile.connector) {
    check(
      "the checklist answers the connector step 'not needed', not blocked",
      before.find((s) => s.id === "connector")?.state === "optional",
      before.find((s) => s.id === "connector")?.detail ?? "",
    );
  }

  if (!modelLive) {
    /*
      The honest outcome with no key: every completion is the orchestrator's
      stub, a classifier reading stub text falls through to its default branch,
      and a run that "succeeded" would mean nothing. The checklist has to say so
      — and this is the assertion that keeps the refusal path real, since it is
      the path CI takes.
    */
    check("with no model key the checklist blocks on the model", blocker?.id === "model");
    console.log(
      `\n${C.dim}Set a provider key (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY) and re-run to drive the sample run itself.${C.off}`,
    );
  } else {
    check("with a model key nothing blocks the first run", blocker === null, blocker?.title ?? "");
    console.log("\nSample run");
    const runAs = owner ? seats.roles[owner.id] : undefined;
    const runOut = await orch("/flows/run", {
      method: "POST",
      body: JSON.stringify({
        id: sample.flow,
        input: crewSampleInputText(sample),
        ...(runAs ? { as: runAs } : {}),
      }),
    });
    check("the run was served by the runtime, not the mock backend", runOut.mocked !== true && runOut.source !== "mock");
    const ran = new Set((runOut.steps ?? []).map((s) => s.stepId));
    if (stub) {
      check("it reached the connector", stub.hits.some((h) => h.startsWith("GET /repos/")), stub.hits.join(", "));
      check(
        "and it never merged, because nothing admitted the merge authority",
        !stub.hits.some((h) => h.startsWith("PUT ")),
      );
    } else {
      /*
        The same refusal, one layer up. This path has no route to watch, so what
        stands in for the stub's hit log is where the run ended: policy answered
        DENY for the publishing endpoint, the branch took its false edge, and
        the run assembled the package a human reads instead of publishing.
      */
      check(
        "it ended in the human sign-off package, not a publication",
        ran.has("signoff") && !ran.has("published"),
        [...ran].join(", ").slice(0, 200),
      );
      check("and it never reached the publication gate at all", !ran.has("publish"));
    }
    const after = crewChecklist(await facts());
    check(
      "the checklist's run step now reads done",
      after.find((s) => s.id === "run")?.state === "done",
    );
  }

  console.log(
    failures === 0
      ? `\n${C.ok}golden path (${BLUEPRINT}): every check held.${C.off}`
      : `\n${C.bad}golden path (${BLUEPRINT}): ${failures} check(s) failed.${C.off}`,
  );
  if (has("--keep-running") && failures === 0) {
    log("stack", `left up on ${ORCH} — ctrl-c to stop`);
    return;
  }
  shutdown(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${C.bad}golden path failed:${C.off} ${err.message}`);
  shutdown(1);
});
