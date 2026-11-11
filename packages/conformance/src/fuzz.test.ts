/**
 * The fuzzer against the simulator alone: no chain to compare with, so what is
 * checked is what must hold of any reachable state — the accounting adds up,
 * the state survives a round trip through JSON, and nothing but a contract
 * revert ever stops a call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kernel } from "@lacrew/sdk/sandbox";

import { Fuzzer, fuzzGenesis, fuzzPrelude, worldInvariants, type FuzzProfile } from "./fuzz.js";
import { Names } from "./refs.js";
import { runStep } from "./runner.js";
import { SimDriver } from "./simDriver.js";

const STEPS = Number(process.env.FUZZ_STEPS ?? 400);
const SEEDS = (process.env.FUZZ_SEEDS ?? "1,2,3,4").split(",").map(Number);

describe("fuzzing the simulator", () => {
  for (const profile of ["direct", "governed"] as FuzzProfile[]) {
    for (const seed of SEEDS) {
      it(`${profile} org, seed ${seed}: ${STEPS} steps keep every invariant`, async () => {
        const driver = new SimDriver();
        await driver.reset(fuzzGenesis(profile));
        const names = new Names(driver.book);
        const label = `fuzz ${profile}/${seed}`;

        const prelude = fuzzPrelude(profile);
        for (const [i, step] of prelude.entries()) await runStep(driver, names, step, i, label);

        const fuzzer = new Fuzzer(seed);
        const outcomes = new Map<string, number>();
        for (let i = 0; i < STEPS; i++) {
          const step = fuzzer.step(driver.world, driver.now());
          const entry = await runStep(driver, names, step, i, label);
          if (entry && "ok" in entry) {
            const key = entry.ok ? "ok" : entry.revert;
            outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
          }
          assert.deepEqual(
            worldInvariants(driver.world),
            [],
            `${label} after step ${i}: ${JSON.stringify(step, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
          );
          if (i % 50 === 0) {
            const text = JSON.stringify(kernel.serializeWorld(driver.world));
            assert.deepEqual(kernel.deserializeWorld(JSON.parse(text)), driver.world);
          }
        }

        // The run must have gone somewhere: calls that landed, and a spread of refusals.
        const landed = outcomes.get("ok") ?? 0;
        assert.ok(landed > STEPS / 5, `${label}: only ${landed} calls landed`);
        assert.ok(outcomes.size > 10, `${label}: only ${outcomes.size} distinct outcomes`);
        assert.equal(outcomes.has("NotSimulated"), false, `${label}: hit an unmodelled function`);
      });
    }
  }
});
