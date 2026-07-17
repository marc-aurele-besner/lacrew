/**
 * Placeholder docs builder.
 * Mocked: copies markdown into dist/; not a real Fumadocs/Docusaurus site yet.
 * TODO: Adopt Fumadocs and publish to docs.lacrew.xyz.
 */

import { cpSync, mkdirSync, existsSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const content = join(root, "content");
const dist = join(root, "dist");

function build() {
  mkdirSync(dist, { recursive: true });
  if (existsSync(content)) {
    cpSync(content, join(dist, "content"), { recursive: true });
  }
  console.log("[@lacrew/docs] Mocked build → dist/content");
}

build();

if (process.argv.includes("--watch")) {
  watch(content, { recursive: true }, () => build());
}
