/**
 * The conformance run proper: every scenario and a differential fuzz, against
 * the simulator and the real contracts side by side.
 *
 * Each scenario runs on both drivers and must produce the same transcript —
 * the same outcome and the same events at every step — and leave the same
 * readable state. The fuzzer then walks both through generated activity,
 * comparing after every call. Where they disagree, the contracts are right.
 *
 * Needs `anvil` (Foundry). Without it the suite is skipped, unless
 * CONFORMANCE_REQUIRE_ANVIL is set — as it is in CI — in which case a missing
 * binary is a failure rather than a silent pass.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { AnvilDriver, findAnvil } from "./anvilDriver.js";
import { Fuzzer, fuzzGenesis, fuzzPrelude, type FuzzProfile } from "./fuzz.js";
import { Names } from "./refs.js";
import { runScenario, runStep, watched } from "./runner.js";
import { SCENARIOS } from "./scenarios/index.js";
import { SimDriver } from "./simDriver.js";
import { snapshot } from "./snapshot.js";

const binary = findAnvil();
const required = Boolean(process.env.CONFORMANCE_REQUIRE_ANVIL);
const STEPS = Number(process.env.FUZZ_STEPS ?? 200);
const SEEDS = (process.env.FUZZ_SEEDS ?? "11,12").split(",").map(Number);
/** How often the fuzz compares the whole readable state, not just the last call. */
const SNAPSHOT_EVERY = Number(process.env.FUZZ_SNAPSHOT_EVERY ?? 1);

const show = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}` : v));

if (!binary && required) {
  it("finds anvil", () => {
    assert.fail("CONFORMANCE_REQUIRE_ANVIL is set but no anvil binary was found");
  });
}

describe("conformance: simulator against the contracts", { skip: !binary }, () => {
  const sim = new SimDriver();
  let anvil: AnvilDriver;

  before(async () => {
    anvil = await AnvilDriver.start(binary!);
  });
  after(async () => {
    await anvil?.close();
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const onChain = await runScenario(anvil, scenario);
      const simulated = await runScenario(sim, scenario);
      assert.equal(simulated.transcript.length, onChain.transcript.length);
      for (const [i, entry] of onChain.transcript.entries()) {
        assert.deepEqual(
          simulated.transcript[i],
          entry,
          `"${scenario.name}": the simulator diverges from the contracts at step ${entry.step}`,
        );
      }
      assert.deepEqual(simulated.final, onChain.final, `"${scenario.name}": final state`);
    });
  }

  for (const profile of ["direct", "governed"] as FuzzProfile[]) {
    for (const seed of SEEDS) {
      it(`differential fuzz, ${profile} org, seed ${seed}: ${STEPS} steps`, async () => {
        const genesis = fuzzGenesis(profile);
        await anvil.reset(genesis);
        await sim.reset(genesis);
        const chainNames = new Names(anvil.book);
        const simNames = new Names(sim.book);
        const label = `fuzz ${profile}/${seed}`;

        const compareState = async (at: string) => {
          assert.deepEqual(
            await snapshot(sim, simNames, watched(simNames)),
            await snapshot(anvil, chainNames, watched(chainNames)),
            `${label}: state differs ${at}`,
          );
        };

        const prelude = fuzzPrelude(profile);
        for (const [i, step] of prelude.entries()) {
          const onChain = await runStep(anvil, chainNames, step, i, label);
          const simulated = await runStep(sim, simNames, step, i, label);
          assert.deepEqual(simulated, onChain, `${label}: prelude step ${i}`);
        }
        await compareState("after the prelude");

        const fuzzer = new Fuzzer(seed);
        for (let i = 0; i < STEPS; i++) {
          const step = fuzzer.step(sim.world, sim.now());
          const simulated = await runStep(sim, simNames, step, i, label);
          const onChain = await runStep(anvil, chainNames, step, i, label);
          assert.deepEqual(
            simulated,
            onChain,
            `${label}: the simulator diverges from the contracts at step ${i}: ${show(step)}`,
          );
          assert.equal(sim.now(), anvil.now(), `${label}: clocks differ after step ${i}`);
          if ((i + 1) % SNAPSHOT_EVERY === 0) await compareState(`after step ${i}: ${show(step)}`);
        }
        await compareState("at the end");
      });
    }
  }
});
