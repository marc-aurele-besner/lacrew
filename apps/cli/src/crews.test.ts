import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCrewBlueprint, type CrewPlanStep } from "@lacrew/flows";
import { cmdCrews } from "./crews.js";

const tmp = mkdtempSync(join(tmpdir(), "lacrew-crews-"));

/** Run a command with stdout captured, so assertions read what a user reads. */
function capture(args: string[]): { out: string; err: string; code: number | undefined } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const priorCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    cmdCrews(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

describe("lacrew crews", () => {
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the blueprints with their shape", () => {
    const { out } = capture(["list"]);
    for (const id of ["defi-desk", "github-experts", "content-studio"]) {
      assert.match(out, new RegExp(id));
    }
    assert.match(out, /seats · \d+ flows/);
  });

  it("shows the org chart, the ladder, and what is not enforced", () => {
    const { out } = capture(["show", "content-studio"]);
    assert.match(out, /Editor manager/);
    assert.match(out, /Social desk/);
    assert.match(out, /deny {2}Publishing endpoint/);
    assert.match(out, /Must never happen/);
    assert.match(out, /residual:/);
    assert.match(out, /Outside LaCrew's reach/);
    // The blueprint validates, so no failure block is printed.
    assert.doesNotMatch(out, /does not validate/);
  });

  it("refuses an unknown blueprint instead of printing an empty one", () => {
    const { err, code } = capture(["show", "not-a-crew"]);
    assert.match(err, /defi-desk/);
    assert.equal(code, 1);
  });

  it("plans in dependency order and names every unbound address", () => {
    const { out } = capture(["plan", "defi-desk"]);
    assert.match(out, /Nothing here has been called/);
    assert.ok(
      out.indexOf("Hire Risk manager") < out.indexOf("Hire Executor"),
      "a report cannot be hired before its manager",
    );
    assert.match(out, /needs: crew.root/);
    assert.match(out, /still unbound/);
  });

  it("stops reporting unbound addresses once they are bound", () => {
    const args = ["plan", "github-experts"];
    for (const [role, addr] of [
      ["root", "0x0000000000000000000000000000000000000001"],
      ["review-lead", "0x0000000000000000000000000000000000000002"],
      ["watcher", "0x0000000000000000000000000000000000000003"],
      ["reviewer", "0x0000000000000000000000000000000000000004"],
      ["merger", "0x0000000000000000000000000000000000000005"],
      ["fixer", "0x0000000000000000000000000000000000000006"],
      ["release-scribe", "0x0000000000000000000000000000000000000007"],
      ["target:model-api", "0x0000000000000000000000000000000000000008"],
      ["target:ci-minutes", "0x0000000000000000000000000000000000000009"],
      ["target:sandbox-runner", "0x000000000000000000000000000000000000000a"],
      ["target:merge-authority", "0x000000000000000000000000000000000000000b"],
      ["target:comment-authority", "0x000000000000000000000000000000000000000c"],
      ["target:push-authority", "0x000000000000000000000000000000000000000d"],
    ] as const) {
      args.push("--bind", `${role}=${addr}`);
    }
    const { out } = capture(args);
    assert.match(out, /Every address is bound/);
    assert.doesNotMatch(out, /needs:/);
  });

  it("shows the certified first run, who it runs as, and what to wire first", () => {
    const { out } = capture(["show", "github-experts"]);
    assert.match(out, /First run/);
    assert.match(out, /bot-pr-triage · runs as Reviewer/);
    assert.match(out, /Wire first: a model provider key, the github connector/);
  });

  it("says a blueprint has no certified sample rather than omitting the section", () => {
    const { out } = capture(["show", "research-desk"]);
    assert.match(out, /First run/);
    assert.match(out, /No certified sample ships/);
  });

  it("emits the sample input alone so it can be piped into a run", () => {
    const { out } = capture(["sample", "github-experts", "--json"]);
    assert.deepEqual(JSON.parse(out), {
      owner: "marc-aurele-besner",
      repo: "lacrew",
      number: 94,
    });
  });

  it("shows the second certified first run and what it does not need", () => {
    const { out } = capture(["show", "content-studio"]);
    assert.match(out, /content-weekly-brief · runs as Editor manager/);
    assert.match(out, /Wire first: a model provider key/);
    // The whole point of the second path: it calls nothing outside LaCrew, so
    // it must not send anyone to register a connector.
    assert.doesNotMatch(out, /Wire first:.*connector/);
  });

  /*
    A `{{input}}` flow interpolates its input verbatim, so the brief goes on the
    wire as itself. Serialized, the model would read a quoted string with its
    own escapes in it and the "pipe it straight into a run" promise would break.
  */
  it("emits a whole-input sample as the brief itself, not as a JSON string", () => {
    const { out } = capture(["sample", "content-studio", "--json"]);
    assert.match(out, /^Account: the LaCrew org blog\./);
    assert.doesNotMatch(out, /^"/);
  });

  // A script asking for an input and getting an empty body must stop, not run
  // a flow with nothing in it.
  it("exits non-zero for a blueprint with no sample", () => {
    const { err, code } = capture(["sample", "research-desk", "--json"]);
    assert.match(err, /No certified sample run ships/);
    assert.equal(code, 1);
  });

  it("writes the plan as JSON when asked", () => {
    const file = join(tmp, "plan.json");
    const { out } = capture(["plan", "content-studio", "--out", file]);
    assert.match(out, /plan steps →/);
    const plan = JSON.parse(readFileSync(file, "utf8")) as CrewPlanStep[];
    assert.ok(plan.length > 0);
    assert.deepEqual(
      plan.map((s) => s.order),
      plan.map((_s, i) => i + 1),
    );
    assert.ok(plan.some((s) => s.kind === "install-flow" && s.via === "http"));
  });
});

/* ------------------------------------------------------------------------- *
 * checklist — probes a running orchestrator, so the tests stand one up.
 * ------------------------------------------------------------------------- */

const GH = getCrewBlueprint("github-experts")!;

/** A wired orchestrator: live runtime, model key, github registered, flows saved. */
function wired(): Record<string, unknown> {
  return {
    "/health": { mode: "chain", mocked: false, chainId: 31337, model: { provider: "openrouter" } },
    "/connectors": { connectors: [{ id: "github", auth: { ready: true } }] },
    "/flows": { flows: GH.flows.map((id) => ({ id })) },
    "/flows/runs": { runs: [{ id: "run_1" }] },
    "/messages": { messages: [{ id: "m1" }] },
    "/org": {
      nodes: [
        { account: "0x00000000000000000000000000000000000000ff", kind: "HumanRoot", label: "You" },
        ...GH.roles.map((role, i) => ({
          account: `0x${String(i + 1).padStart(40, "0")}`,
          kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
          label: role.label,
        })),
      ],
    },
  };
}

const CS = getCrewBlueprint("content-studio")!;

/** The same, for the second certified blueprint — which registers no connector. */
function contentWired(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/health": { mode: "chain", mocked: false, chainId: 31337, model: { provider: "openrouter" } },
    "/connectors": { connectors: [] },
    "/flows": { flows: CS.flows.map((id) => ({ id })) },
    "/flows/runs": { runs: [{ id: "run_1" }] },
    "/messages": { messages: [{ id: "m1" }] },
    "/org": {
      nodes: [
        { account: "0x00000000000000000000000000000000000000ff", kind: "HumanRoot", label: "You" },
        ...CS.roles.map((role, i) => ({
          account: `0x${String(i + 1).padStart(40, "0")}`,
          kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
          label: role.label,
        })),
      ],
    },
    ...over,
  };
}

/** Serve one canned body per path; `null` makes that probe fail with a 503. */
async function withOrch(
  routes: Record<string, unknown>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const body = routes[path];
    if (body === undefined || body === null) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function captureAsync(
  args: string[],
): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const priorCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    await cmdCrews(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = priorCode;
  return { out: out.join("\n"), err: err.join("\n"), code: code as number | undefined };
}

describe("lacrew crews checklist", () => {
  it("exits zero and clears every step against a wired orchestrator", async () => {
    await withOrch(wired(), async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /first run {2}7\/7/);
      assert.match(out, /Nothing is in the way/);
      assert.equal(code, undefined);
    });
  });

  // The acceptance the issue names: an unwired connector must fail a script.
  it("exits non-zero when the connector is not registered", async () => {
    await withOrch({ ...wired(), "/connectors": { connectors: [] } }, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /github is not registered/);
      assert.match(out, /Connector is what stands between/);
      assert.equal(code, 1);
    });
  });

  it("exits non-zero when the connector is registered without a credential", async () => {
    const routes = {
      ...wired(),
      "/connectors": { connectors: [{ id: "github", auth: { ready: false } }] },
    };
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /credential is not set/);
      assert.equal(code, 1);
    });
  });

  /*
    Nothing having run is the outcome the checklist drives at, not a reason to
    refuse. A script that gated on it could never fire a first run.
  */
  it("does not fail on a crew that is wired but has never run", async () => {
    const routes = { ...wired(), "/flows/runs": { runs: [] }, "/messages": { messages: [] } };
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /▲ First run/);
      assert.match(out, /Nothing is in the way/);
      assert.equal(code, undefined);
    });
  });

  /*
    The rename case, end to end: the org chart carries a label the blueprint
    never used, and the stored role id is the only thing that can find the seat.
  */
  it("still resolves a renamed seat when its role id was persisted", async () => {
    const routes = wired();
    const org = routes["/org"] as { nodes: Array<Record<string, unknown>> };
    routes["/org"] = {
      nodes: org.nodes.map((n) =>
        n.label === "Reviewer" ? { ...n, label: "PR gatekeeper", roleId: "reviewer" } : n,
      ),
    };
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /All 6 seats hold accounts/);
      assert.doesNotMatch(out, /Seats nothing matched/);
      assert.equal(code, undefined);
    });
  });

  it("names the seats nothing matched rather than binding a wrong address", async () => {
    const routes = wired();
    const org = routes["/org"] as { nodes: Array<Record<string, unknown>> };
    routes["/org"] = {
      nodes: org.nodes.map((n) => (n.label === "Reviewer" ? { ...n, label: "PR gatekeeper" } : n)),
    };
    await withOrch(routes, async (url) => {
      const { out } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /Seats nothing matched: reviewer/);
      assert.match(out, /5 of 6 seats have an account/);
    });
  });

  /*
    An unreachable probe is "we cannot say", not "it is broken": rendering it as
    a blocker would send an operator to fix a connector that is fine.
  */
  it("reports an unreadable probe as unknown and still exits zero", async () => {
    await withOrch({ ...wired(), "/connectors": null }, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /– Connector/);
      assert.match(out, /unknown whether github is registered/);
      assert.equal(code, undefined);
    });
  });

  it("blocks on a mock-mode runtime", async () => {
    const routes = {
      ...wired(),
      "/health": { mode: "mock", mocked: true, model: { provider: "memory" } },
    };
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /running in mock mode/);
      assert.equal(code, 1);
    });
  });

  it("emits the derivation as JSON for a script to read", async () => {
    await withOrch({ ...wired(), "/connectors": { connectors: [] } }, async (url) => {
      const { out, code } = await captureAsync([
        "checklist",
        "github-experts",
        "--url",
        url,
        "--json",
      ]);
      const body = JSON.parse(out) as { blocker: string; steps: Array<{ id: string }> };
      assert.equal(body.blocker, "connector");
      assert.equal(body.steps.length, 7);
      assert.equal(code, 1);
    });
  });

  it("refuses an unknown blueprint rather than probing for nothing", async () => {
    const { err, code } = await captureAsync(["checklist", "not-a-blueprint"]);
    assert.match(err, /Usage: lacrew crews checklist/);
    assert.equal(code, 1);
  });

  /* ----------------------------------------------------------------- *
   * The second certified vertical (F2.25). Its first run leaves LaCrew
   * nowhere, so it exercises the branch `github-experts` never can: the
   * connector step is answered *not needed* rather than blocked, and no
   * connector is what stands in the way of the first run.
   * ----------------------------------------------------------------- */
  it("clears content-studio with no connector registered at all", async () => {
    await withOrch(contentWired({ "/connectors": { connectors: [] } }), async (url) => {
      const { out, code } = await captureAsync(["checklist", "content-studio", "--url", url]);
      assert.match(out, /first run {2}7\/7/);
      assert.match(out, /· Connector/);
      assert.match(out, /does not leave LaCrew/);
      assert.match(out, /Nothing is in the way/);
      assert.equal(code, undefined);
    });
  });

  // Its honest blocker is the model, and the checklist has to name that one
  // rather than a credential nothing on this path would use.
  it("blocks content-studio on the model, not on a connector", async () => {
    const routes = contentWired({
      "/connectors": { connectors: [] },
      "/health": { mode: "chain", mocked: false, chainId: 31337, model: { provider: "memory" } },
    });
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "content-studio", "--url", url]);
      assert.match(out, /Model provider is what stands between/);
      assert.equal(code, 1);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * bind — the seat mapping kept by the orchestrator instead of a plan file.
 * ------------------------------------------------------------------------- */

/**
 * An orchestrator that actually remembers what was bound.
 *
 * `withOrch` serves canned bodies, which is right for a checklist read and
 * wrong here: the whole claim is that a write lands and the next read — of
 * `/crew/bindings` *and* of `/org` — reflects it.
 */
async function withBindingOrch(
  seed: { nodes: Array<Record<string, unknown>> },
  run: (
    url: string,
    stored: Map<string, { roleId: string; account: string; label?: string }>,
  ) => Promise<void>,
): Promise<void> {
  const stored = new Map<string, { roleId: string; account: string; label?: string }>();
  const server: Server = createServer((req, res) => {
    const [path] = (req.url ?? "").split("?") as [string];
    const send = (body: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const list = () => [...stored.values()];
    const roles = () => Object.fromEntries(list().map((b) => [b.roleId, b.account]));

    if (path === "/org") {
      const byAccount = new Map(list().map((b) => [b.account, b.roleId]));
      send({
        nodes: seed.nodes.map((n) => {
          const roleId = byAccount.get(String(n.account).toLowerCase());
          return roleId ? { ...n, roleId } : n;
        }),
      });
      return;
    }
    if (path === "/crew/bindings" && req.method === "GET") {
      send({ bindings: list(), roles: roles() });
      return;
    }
    if (path === "/crew/bindings" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
          roles?: Record<string, string>;
          labels?: Record<string, string>;
        };
        const cleared: string[] = [];
        for (const [roleId, account] of Object.entries(body.roles ?? {})) {
          if (!account.trim()) {
            if (stored.delete(roleId)) cleared.push(roleId);
            continue;
          }
          if (!/^0x[0-9a-fA-F]{40}$/.test(account.trim())) {
            send({ error: "crew_binding_account_invalid", bindings: list() }, 400);
            return;
          }
          stored.set(roleId, {
            roleId,
            account: account.trim().toLowerCase(),
            ...(body.labels?.[roleId] ? { label: body.labels[roleId]! } : {}),
          });
        }
        send({ bindings: list(), roles: roles(), ...(cleared.length ? { cleared } : {}) });
      });
      return;
    }
    send({ error: "unavailable" }, 503);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`, stored);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The chart a hand install leaves: blueprint labels, no role ids anywhere. */
function ghChart(
  over: (role: (typeof GH.roles)[number], i: number) => Record<string, unknown> = () => ({}),
) {
  return {
    nodes: [
      { account: "0x00000000000000000000000000000000000000ff", kind: "HumanRoot", label: "You" },
      ...GH.roles.map((role, i) => ({
        account: `0x${String(i + 1).padStart(40, "0")}`,
        kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
        label: role.label,
        ...over(role, i),
      })),
    ],
  };
}

describe("lacrew crews bind", () => {
  it("prints what is stored, seat by seat, when asked for nothing", async () => {
    await withBindingOrch(ghChart(), async (url) => {
      const { out } = await captureAsync(["bind", "github-experts", "--url", url]);
      assert.match(out, /seats bound on the orchestrator {2}0\/6/);
      assert.match(out, /· reviewer {2}unbound/);
      assert.match(out, /admits nothing and budgets nothing/);
    });
  });

  it("records the account an operator names, and reads it back", async () => {
    await withBindingOrch(ghChart(), async (url, stored) => {
      const { out } = await captureAsync([
        "bind",
        "github-experts",
        "--url",
        url,
        "--bind",
        "reviewer=0x0000000000000000000000000000000000000004",
      ]);
      assert.match(out, /✓ reviewer {2}0x0{39}4/);
      assert.equal(stored.get("reviewer")?.account, "0x0000000000000000000000000000000000000004");
    });
  });

  /*
    The move that matters after a hand install: the labels still agree with the
    blueprint *now*, so writing the ids down is what makes the next read survive
    the first rename.
  */
  it("--from-org persists every seat a label match found, with its label", async () => {
    await withBindingOrch(ghChart(), async (url, stored) => {
      const { out } = await captureAsync(["bind", "github-experts", "--url", url, "--from-org"]);
      assert.match(out, /seats bound on the orchestrator {2}6\/6/);
      assert.equal(stored.size, GH.roles.length);
      assert.equal(stored.get("reviewer")?.label, "Reviewer");
    });
  });

  it("--from-org binds nothing for a seat nothing matched, and names it", async () => {
    const chart = ghChart((role) => (role.id === "reviewer" ? { label: "PR gatekeeper" } : {}));
    await withBindingOrch(chart, async (url, stored) => {
      const { out } = await captureAsync(["bind", "github-experts", "--url", url, "--from-org"]);
      assert.match(out, /Seats nothing matched.*reviewer/);
      assert.equal(stored.has("reviewer"), false);
    });
  });

  it("forgets a seat on a blank address", async () => {
    await withBindingOrch(ghChart(), async (url, stored) => {
      await captureAsync(["bind", "github-experts", "--url", url, "--from-org"]);
      const { out } = await captureAsync([
        "bind",
        "github-experts",
        "--url",
        url,
        "--bind",
        "reviewer=",
      ]);
      assert.match(out, /Forgot: reviewer/);
      assert.equal(stored.has("reviewer"), false);
    });
  });

  it("reports a refused address rather than claiming it was bound", async () => {
    await withBindingOrch(ghChart(), async (url, stored) => {
      const { err, code } = await captureAsync([
        "bind",
        "github-experts",
        "--url",
        url,
        "--bind",
        "reviewer=not-an-address",
      ]);
      assert.match(err, /Nothing was bound/);
      assert.equal(stored.size, 0);
      assert.equal(code, 1);
    });
  });

  it("exits non-zero when no orchestrator answers", async () => {
    const { err, code } = await captureAsync([
      "bind",
      "github-experts",
      "--url",
      "http://127.0.0.1:1",
    ]);
    assert.match(err, /did not answer/);
    assert.equal(code, 1);
  });

  /*
    The acceptance criterion, end to end and without a plan file: bind the
    seats, rename one on the chart, and the checklist still resolves all six —
    with no `--bind` on the command line at all.
  */
  it("leaves the checklist resolving a renamed seat with no --bind flag", async () => {
    await withBindingOrch(ghChart(), async (url) => {
      await captureAsync(["bind", "github-experts", "--url", url, "--from-org"]);
      const { out } = await captureAsync(["bind", "github-experts", "--url", url, "--json"]);
      const body = JSON.parse(out) as { roles: Record<string, string> };
      assert.equal(Object.keys(body.roles).length, GH.roles.length);
    });
  });
});

describe("lacrew crews checklist — where a seat's id came from", () => {
  it("names the seats only a label found, and how to persist them", async () => {
    await withOrch(wired(), async (url) => {
      const { out } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /Resolved by label, not by a stored id/);
      assert.match(out, /lacrew crews bind github-experts --from-org/);
    });
  });

  it("says nothing about labels once every seat carries a stored id", async () => {
    const routes = wired();
    const org = routes["/org"] as { nodes: Array<Record<string, unknown>> };
    routes["/org"] = {
      nodes: org.nodes.map((n) => {
        const role = GH.roles.find((r) => r.label === n.label);
        return role ? { ...n, roleId: role.id } : n;
      }),
    };
    await withOrch(routes, async (url) => {
      const { out, code } = await captureAsync(["checklist", "github-experts", "--url", url]);
      assert.match(out, /All 6 seats hold accounts/);
      assert.doesNotMatch(out, /Resolved by label/);
      assert.equal(code, undefined);
    });
  });
});
