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
    const routes = { ...wired(), "/connectors": { connectors: [{ id: "github", auth: { ready: false } }] } };
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
    const routes = { ...wired(), "/health": { mode: "mock", mocked: true, model: { provider: "memory" } } };
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
});
