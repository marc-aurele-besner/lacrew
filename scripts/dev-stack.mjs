#!/usr/bin/env node
/**
 * Boot the whole local stack against a real chain.
 *
 *   pnpm dev:stack
 *
 * Order matters and is why this is a script rather than a turbo pipeline:
 * contracts must be deployed before the orchestrator starts, or it comes up
 * pointed at addresses with no code. Turbo can express "build before dev", not
 * "this one-shot task finishes before those two long-running ones start".
 *
 * The point of this script is that a real chain is the *default* way to run
 * LaCrew. When standing one up was four manual terminals, mock mode won by
 * default, and every surface downstream inherited fabricated data.
 *
 * Flags:
 *   --no-postgres   skip docker compose + migrations (queues fall back to memory)
 *   --no-indexer    skip the event indexer (audit trail will be thin)
 *   --keep-chain    reuse an Anvil already listening instead of starting one
 *   --verbose       keep Anvil's per-RPC-call logging
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

// Children inherit this process's env, and the package scripts we spawn do not
// all load .env themselves (`db:migrate` reads DATABASE_URL directly). Load it
// here so every child sees the same configuration the orchestrator does.
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

const RPC = process.env.ANVIL_RPC ?? "http://127.0.0.1:8545";
const ORCH_PORT = process.env.PORT ?? "8788";

/** Children we started, newest first, so teardown unwinds in reverse. */
const children = [];
let shuttingDown = false;

const COLORS = { anvil: "\x1b[35m", deploy: "\x1b[33m", orchestrator: "\x1b[36m", indexer: "\x1b[32m" };
const RESET = "\x1b[0m";

function log(name, line) {
  const colour = COLORS[name] ?? "";
  process.stdout.write(`${colour}[${name}]${RESET} ${line}\n`);
}

/**
 * Anvil echoes one line per JSON-RPC call. A deploy is thousands of them, which
 * buries the orchestrator and indexer output this script exists to surface.
 * Method-name-only lines are dropped; anything else (banner, errors, mined
 * blocks) is kept. `--verbose` restores the firehose.
 */
const RPC_CHATTER = /^(eth|anvil|web3|net|debug|trace)_[A-Za-z]+$/;

function isNoise(name, line) {
  if (has("--verbose")) return false;
  return name === "anvil" && RPC_CHATTER.test(line.trim());
}

/** Long-running child; its output is prefixed and it joins the teardown list. */
function spawnService(name, command, cmdArgs, env = {}) {
  const child = spawn(command, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim() && !isNoise(name, line)) log(name, line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    log(name, `exited with code ${code}`);
    // One service dying leaves a stack that looks alive but isn't. Fail loudly.
    shutdown(code ?? 1);
  });
  children.unshift({ name, child });
  return child;
}

/** One-shot child; resolves on exit, rejects on non-zero. */
function run(name, command, cmdArgs, env = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, cmdArgs, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pipe = (s) => s.on("data", (c) => c.toString().split("\n").forEach((l) => l.trim() && log(name, l)));
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${name} exited with code ${code}`)),
    );
  });
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

async function waitFor(label, probe, { attempts = 60, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { name, child } of children) {
    log(name, "stopping");
    child.kill("SIGTERM");
  }
  // Give children a moment to exit cleanly before the process goes.
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  if (!existsSync(resolve(ROOT, ".env"))) {
    console.error("No .env — copy .env.example first (it ships working Anvil defaults).");
    process.exit(1);
  }

  if (!has("--no-postgres")) {
    log("deploy", "starting postgres");
    await run("deploy", "docker", ["compose", "up", "-d", "postgres"]);
    await run("deploy", "pnpm", ["db:migrate"]);
  }

  const chainAlreadyUp = await rpcReady(RPC);
  if (chainAlreadyUp && !has("--keep-chain")) {
    log("anvil", `something is already listening on ${RPC} — reusing it`);
  } else if (!chainAlreadyUp) {
    log("anvil", "starting");
    spawnService("anvil", "anvil", ["--host", "127.0.0.1"]);
    await waitFor("anvil", () => rpcReady(RPC));
  }

  // Deploys the org, funds the treasury, syncs ABIs + addresses into
  // @lacrew/core. Idempotent in the sense that re-running redeploys fresh
  // contracts and rewrites the address book.
  log("deploy", "deploying contracts (DeployMockOrg)");
  await run("deploy", "pnpm", ["--filter", "@lacrew/cli", "exec", "tsx", "src/index.ts", "deploy", "--anvil"]);

  log("orchestrator", "starting");
  // `dev:once`, not `dev`: here the orchestrator is infrastructure for the
  // loop, and hot-reloading it on every save restarts the chain-facing process
  // for edits that usually have nothing to do with it. `pnpm dev` still
  // watches, for anyone actually working on the orchestrator.
  spawnService("orchestrator", "pnpm", ["--filter", "@lacrew/orchestrator", "dev:once"]);
  await waitFor("orchestrator", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${ORCH_PORT}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  });

  if (!has("--no-indexer")) {
    log("indexer", "starting");
    spawnService("indexer", "pnpm", ["--filter", "@lacrew/indexer", "dev"]);
  }

  const health = await fetch(`http://127.0.0.1:${ORCH_PORT}/health`).then((r) => r.json());
  log("orchestrator", `ready — mode=${health.mode} chainId=${health.chainId}`);
  if (health.mode !== "onchain") {
    log("orchestrator", "WARNING: not onchain. Check ANVIL_RPC and PRIVATE_KEY in .env.");
  }
  log("deploy", `stack up. orchestrator http://127.0.0.1:${ORCH_PORT} · chain ${RPC}`);
  log("deploy", "ctrl-c to stop everything");
}

main().catch((err) => {
  console.error(`\ndev-stack failed: ${err.message}`);
  shutdown(1);
});
