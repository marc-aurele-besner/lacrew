/**
 * Runs TypeDoc to regenerate the API reference, falling back to an empty
 * placeholder when TypeDoc cannot start (PRD F1.14).
 *
 * TypeScript 7 removed the legacy `import ts from "typescript"` default export
 * that TypeDoc 0.28.x (the latest at the time of writing) reads at startup,
 * and no published TypeDoc release yet supports the new `unstable/ast`
 * subpath exports. The next release is expected to add the support; until
 * then, every CI run would fail at the API reference step and take the rest
 * of the docs site down with it.
 *
 * Falling back to an empty page means:
 *   - the docs site still builds and deploys
 *   - the `/reference` page is reachable but says so
 *   - the moment TypeDoc ships TS 7 support, removing this wrapper restores
 *     the generated API reference with no other change
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reference = join(root, "content", "reference");
const typedocBin = join(root, "node_modules", ".bin", "typedoc");

if (!existsSync(typedocBin)) {
  console.warn("[@lacrew/docs] typedoc binary not found — skipping API reference");
  writeEmptyReference();
  process.exit(0);
}

const child = spawn(typedocBin, [], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});

child.on("exit", (code, signal) => {
  if (code === 0) return;
  console.warn(
    `[@lacrew/docs] typedoc exited with code=${code} signal=${signal} ` +
      "(TypeScript 7 removed the legacy namespace; TypeDoc 0.28.x cannot start). " +
      "Writing an empty API reference so the docs site still builds.",
  );
  writeEmptyReference();
  process.exit(0);
});

const modulePlaceholder = (title) =>
  [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(`${title} API reference — unavailable until TypeDoc supports TypeScript 7.`)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "API reference for this package is temporarily unavailable: the `typedoc`",
    "package (the latest release at the time of writing) has not yet shipped",
    "support for TypeScript 7, which removed the legacy `import ts from",
    '"typescript"` namespace export that TypeDoc reads at startup.',
    "",
    "See the published package on npm for the current surface.",
    "",
  ].join("\n");

function writeEmptyReference() {
  mkdirSync(reference, { recursive: true });
  writeFileSync(join(reference, "index.md"), modulePlaceholder("API reference"));
  for (const dir of ["sdk", "flows"]) {
    const target = join(reference, dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.md"), modulePlaceholder(`@lacrew/${dir}`));
  }
}
