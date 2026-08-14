/**
 * Turns generated markdown into Fumadocs content (PRD F1.14).
 *
 * Two sources are not written by hand and so are not checked in:
 *   - the repo's SPEC.md, published as `/spec`
 *   - TypeDoc output under `content/reference/`
 *
 * Both need what every Fumadocs page needs: frontmatter with a title, links
 * that resolve on the site, and `index.md` rather than `README.md` for the
 * page a folder opens on.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const content = join(root, "content");
const reference = join(content, "reference");
const repoRoot = join(root, "..", "..");
const repoBlob = "https://github.com/marc-aurele-besner/lacrew/blob/main";

/** The TypeDoc entry points, named after the package they document. */
const modules = [
  { dir: "sdk", title: "@lacrew/sdk" },
  { dir: "flows", title: "@lacrew/flows" },
];

function walkMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function frontmatter(title, description) {
  const lines = [`title: ${JSON.stringify(title)}`];
  if (description) lines.push(`description: ${JSON.stringify(description)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * Publish the root SPEC.md as a page (PRD F0.11). Repo-relative links are
 * rewritten: in-site targets to their page, everything else to GitHub.
 */
function importSpec() {
  const src = join(repoRoot, "SPEC.md");
  if (!existsSync(src)) return;
  const md = readFileSync(src, "utf8")
    // Links into apps/docs/content are pages on this site. Their link text is
    // written as a repo path, so retarget both text and href.
    .replace(
      /\[`apps\/docs\/content\/([^`]*)`\]\(\.\/apps\/docs\/content\/[^)]*\)/g,
      (_, target) => {
        const page = target.endsWith("/") ? `${target}overview.md` : target;
        const label = basename(page, ".md").replace(/-/g, " ");
        return `[${label} docs](./${page})`;
      },
    )
    // Everything else in the repo is only reachable on GitHub.
    .replaceAll("./SECURITY.md", `${repoBlob}/SECURITY.md`)
    .replaceAll("./contracts/src/", `${repoBlob}/contracts/src/`);

  const title =
    md
      .split("\n")
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? "Protocol specification";
  const body = md.replace(/^#\s+.*\n+/, "");
  writeFileSync(
    join(content, "spec.md"),
    frontmatter(title, "The normative interface surface, invariants, and conformance rules.") +
      body,
  );
}

/**
 * TypeDoc names its modules after the entry file's path (`sdk/src`), which
 * would surface in the sidebar and in every generated URL. Lift each module a
 * level so pages live at `/reference/sdk/...`.
 */
function flattenModuleDirs() {
  for (const { dir } of modules) {
    const src = join(reference, dir, "src");
    if (!existsSync(src)) continue;
    for (const name of readdirSync(src)) {
      const to = join(reference, dir, name);
      rmSync(to, { recursive: true, force: true });
      renameSync(join(src, name), to);
    }
    rmSync(src, { recursive: true, force: true });
  }
}

/** A folder's entry page is `index.md` in Fumadocs, not `README.md`. */
function renameReadmes() {
  for (const file of walkMarkdown(reference)) {
    if (basename(file) !== "README.md") continue;
    renameSync(file, join(dirname(file), "index.md"));
  }
}

function rewriteReference() {
  for (const file of walkMarkdown(reference)) {
    const raw = readFileSync(file, "utf8");
    // Already rewritten (the script reruns without a fresh TypeDoc pass).
    if (raw.startsWith("---\n")) continue;
    const lines = raw.split("\n");
    const headingIndex = lines.findIndex((line) => line.startsWith("# "));
    const heading =
      headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, "").trim() : basename(file, ".md");

    // Fumadocs renders the frontmatter title as the page heading, so the
    // generated H1 would otherwise appear twice.
    if (headingIndex >= 0) {
      lines.splice(headingIndex, lines[headingIndex + 1]?.trim() === "" ? 2 : 1);
    }

    const body = lines
      .join("\n")
      .replace(/^\n+/, "")
      // Follow the two renames above so in-page links still land.
      .replaceAll("/src/", "/")
      .replace(/README\.md/g, "index.md");

    const name = heading.replace(/\/src$/, "");
    const title =
      name === "lacrew" ? "API reference" : (modules.find((m) => m.dir === name)?.title ?? name);
    writeFileSync(file, frontmatter(title) + body);
  }
}

/**
 * Sidebar labels for the generated tree, which has no meta files of its own.
 * The reference is a sidebar root: 390 generated symbol pages next to 21
 * hand-written ones would bury them, so it gets its own section instead.
 */
function writeReferenceMeta() {
  mkdirSync(reference, { recursive: true });
  writeFileSync(
    join(reference, "meta.json"),
    `${JSON.stringify(
      {
        title: "API reference",
        description: "Generated from source by TypeDoc",
        root: true,
        pages: ["index", ...modules.map((m) => m.dir)],
      },
      null,
      2,
    )}\n`,
  );
  for (const { dir, title } of modules) {
    const target = join(reference, dir);
    if (!existsSync(target)) continue;
    writeFileSync(join(target, "meta.json"), `${JSON.stringify({ title }, null, 2)}\n`);
  }
}

importSpec();
flattenModuleDirs();
renameReadmes();
rewriteReference();
writeReferenceMeta();

const pages = walkMarkdown(content).length;
console.log(`[@lacrew/docs] content prepared (${pages} markdown pages)`);
