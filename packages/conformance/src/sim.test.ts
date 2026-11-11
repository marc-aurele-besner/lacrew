/**
 * The scenario suite against the simulator alone. Runs in the ordinary
 * `pnpm test`: it needs no toolchain, and it is what keeps a change to the
 * sandbox honest between runs of the chain-backed suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runScenario } from "./runner.js";
import { SCENARIOS } from "./scenarios/index.js";
import { SimDriver } from "./simDriver.js";

describe("conformance scenarios on the simulator", () => {
  const driver = new SimDriver();

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const first = await runScenario(driver, scenario);
      // A scenario is a pure function of its steps: the same run, twice.
      const second = await runScenario(driver, scenario);
      assert.deepEqual(second, first);
    });
  }

  it("has a unique name for every scenario", () => {
    const names = SCENARIOS.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });
});
