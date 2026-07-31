/**
 * Running the eval suite from a workspace (PRD F2.29, cloud half).
 *
 * The harness itself is offline and deterministic, and CI has run it since it
 * shipped. What was missing is the operator's version of the same question:
 * *my* desk, the blueprint I installed, right now — does it still refuse what
 * it claims to refuse? Reading a CI badge on someone else's repository is not
 * an answer to that.
 *
 * Two decisions worth stating, because both are about not breaking a funded
 * crew to run a test:
 *
 * 1. **The suite runs in a child process.** The harness blocks `fetch` for the
 *    duration of a run, which in this process would fail every connector call,
 *    model completion and RPC read that happened to be in flight. The child
 *    exists to be blocked (`@lacrew/flows/evalRun`).
 * 2. **One run at a time, with a deadline.** An eval is cheap, but a route that
 *    lets anyone fan out subprocesses is a way to take an orchestrator down
 *    from the outside. A second request while one is running is refused with
 *    `eval_already_running` rather than queued, because the caller wants a
 *    result now and a queue would hand them a stale one later.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export type EvalScenarioListing = {
  id: string;
  describe?: string;
  flow?: string;
  blueprint?: string;
};

export type EvalRunFailure = {
  assertion: string;
  detail: string;
  expected?: unknown;
  actual?: unknown;
};

export type EvalRunResult = {
  id: string;
  ok: boolean;
  flowId: string;
  describe?: string;
  failures: EvalRunFailure[];
  calls: Array<{ kind: string; name: string; connector?: string }>;
  gatesOpen: string[];
  status?: string;
};

export type EvalSuiteRun = {
  ok: boolean;
  passed: number;
  failed: number;
  /** How many scenarios the filter selected. Zero is reported, never hidden. */
  matched: number;
  results: EvalRunResult[];
  ms: number;
};

export type EvalRunnerSurface = {
  /** Scenarios this build ships, for a surface that offers them. */
  list(): Promise<EvalScenarioListing[]>;
  run(filter: { ids?: string[]; flow?: string; blueprint?: string }): Promise<EvalSuiteRun>;
  /** Whether a run is in flight, for the 409 and for `/health`. */
  busy(): boolean;
};

/** A suite that cannot finish in this long is one an operator should not wait on. */
export const DEFAULT_EVAL_TIMEOUT_MS = 120_000;

export function evalTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.LACREW_EVAL_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_EVAL_TIMEOUT_MS;
}

/**
 * Path to the child entry point, resolved through the package's own exports so
 * it keeps working under pnpm's links and in a published install.
 */
export function resolveEvalRunner(): string {
  return createRequire(import.meta.url).resolve("@lacrew/flows/evalRun");
}

export type EvalRunnerOptions = {
  timeoutMs?: number;
  /** Injected in tests; defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Injected in tests; defaults to the resolved `@lacrew/flows/evalRun`. */
  scriptPath?: string;
  /** Injected in tests; defaults to `process.execPath`. */
  nodePath?: string;
  now?: () => number;
};

export function createEvalRunner(opts: EvalRunnerOptions = {}): EvalRunnerSurface {
  const timeoutMs = opts.timeoutMs ?? evalTimeoutMs();
  const spawnImpl = opts.spawnImpl ?? spawn;
  const now = opts.now ?? Date.now;
  let running = false;

  /** Spawn the child, collect stdout, and parse the one JSON document it writes. */
  const invoke = async (args: string[]): Promise<unknown> => {
    const script = opts.scriptPath ?? resolveEvalRunner();
    const child = spawnImpl(opts.nodePath ?? process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // The child needs no credentials: an eval reaches no network and no
      // chain, so handing it this process's environment would give a test
      // harness the session sealing key for nothing.
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "" },
    });

    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (err += chunk));

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("eval_timeout"));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`eval_spawn_failed: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!out.trim()) {
          // A child that printed nothing failed in a way its own report cannot
          // describe; its stderr is the only thing that can, so it is carried
          // rather than swallowed behind a generic message.
          reject(new Error(`eval_no_output (exit ${code}): ${err.trim().slice(0, 400)}`));
          return;
        }
        try {
          resolve(JSON.parse(out) as unknown);
        } catch {
          reject(new Error(`eval_unreadable_output (exit ${code})`));
        }
      });
    });
  };

  return {
    busy: () => running,

    list: async () => {
      const body = (await invoke(["--list"])) as { scenarios?: EvalScenarioListing[] };
      return body.scenarios ?? [];
    },

    run: async (filter) => {
      if (running) throw new Error("eval_already_running");
      running = true;
      const started = now();
      try {
        const args: string[] = [];
        if (filter.ids?.length) args.push("--ids", filter.ids.join(","));
        if (filter.flow) args.push("--flow", filter.flow);
        if (filter.blueprint) args.push("--blueprint", filter.blueprint);
        const body = (await invoke(args)) as Omit<EvalSuiteRun, "ms">;
        return {
          ok: body.ok === true,
          passed: body.passed ?? 0,
          failed: body.failed ?? 0,
          matched: body.matched ?? 0,
          results: body.results ?? [],
          ms: now() - started,
        };
      } finally {
        running = false;
      }
    },
  };
}
