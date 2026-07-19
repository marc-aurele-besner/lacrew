import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { validateFlow, type FlowDefinition } from "@lacrew/flows";
import { listTemplateIds, resolveTemplate, scaffoldTemplate } from "./scaffold.js";

const tmp = mkdtempSync(join(tmpdir(), "lacrew-scaffold-"));

describe("lacrew scaffold", () => {
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves templates with and without the tpl- prefix", () => {
    assert.ok(resolveTemplate("tpl-treasury-pulse"));
    assert.ok(resolveTemplate("treasury-pulse") ?? resolveTemplate("tpl-treasury-pulse"));
    assert.equal(resolveTemplate("nope"), undefined);
    assert.ok(listTemplateIds().length >= 4);
  });

  it("writes a runnable project with a valid flow definition", () => {
    const result = scaffoldTemplate({
      template: "tpl-treasury-pulse",
      dir: join(tmp, "pulse"),
      cwd: tmp,
    });
    assert.deepEqual(result.files.sort(), [
      ".env.example",
      "README.md",
      "crew.ts",
      "flows/treasury-pulse.json",
      "package.json",
    ]);

    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, "crew-treasury-pulse");
    assert.equal(pkg.scripts.start, "tsx crew.ts");
    assert.ok(pkg.dependencies["@lacrew/flows"]);

    const def = JSON.parse(
      readFileSync(join(result.dir, "flows/treasury-pulse.json"), "utf8"),
    ) as FlowDefinition;
    const validation = validateFlow(def);
    assert.equal(validation.ok, true, JSON.stringify(validation));
  });

  it("links @lacrew/flows via file: when scaffolding inside the repo", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const result = scaffoldTemplate({
      template: "budget-guarded-spend",
      dir: join(tmp, "guarded"),
      cwd: tmp,
      repoRoot,
    });
    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.ok(pkg.dependencies["@lacrew/flows"]?.startsWith("file:"));
  });

  it("refuses to overwrite an existing project", () => {
    assert.ok(existsSync(join(tmp, "pulse", "package.json")));
    assert.throws(
      () => scaffoldTemplate({ template: "tpl-treasury-pulse", dir: join(tmp, "pulse"), cwd: tmp }),
      /target_not_empty/,
    );
  });

  it("rejects unknown templates with the available list", () => {
    assert.throws(
      () => scaffoldTemplate({ template: "does-not-exist", dir: join(tmp, "x"), cwd: tmp }),
      /unknown_template/,
    );
  });
});
