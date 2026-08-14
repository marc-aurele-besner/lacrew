/**
 * Finishes the static export for GitHub Pages (PRD F1.14):
 *
 *   - `.nojekyll`, without which Pages drops `_next/` and the site loads no CSS
 *   - `CNAME`, the custom domain, kept for whenever the DNS record exists
 *   - `<page>.html` redirects, because the site published `/spec.html` style
 *     URLs before this build laid pages out as `/spec/index.html`
 *
 * `build_type=workflow` deploys ignore the CNAME file — the domain is set in
 * repo settings — but writing it keeps the artifact self-describing.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { basePath } from "../base-path.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");

if (!existsSync(out)) {
  console.error("[@lacrew/docs] no out/ directory — did `next build` run?");
  process.exit(1);
}

/** Every exported page directory, as a site-relative slug. */
function pageDirs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory() || name === "_next") continue;
    if (existsSync(join(full, "index.html"))) out.push(full);
    pageDirs(full, out);
  }
  return out;
}

function redirect(to) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<title>Redirecting…</title>
<link rel="canonical" href="${to}" />
<meta http-equiv="refresh" content="0; url=${to}" />
<p>This page moved to <a href="${to}">${to}</a>.</p>
</html>
`;
}

let redirects = 0;
for (const dir of pageDirs(out)) {
  // Next writes its own `404.html`; a redirect there would break the error page.
  if (existsSync(`${dir}.html`)) continue;
  const url = `${basePath}/${relative(out, dir)}/`;
  writeFileSync(`${dir}.html`, redirect(url));
  redirects += 1;
}

writeFileSync(join(out, ".nojekyll"), "");
writeFileSync(join(out, "CNAME"), "docs.lacrew.xyz\n");

console.log(`[@lacrew/docs] static export ready → out/ (${redirects} legacy .html redirects)`);
