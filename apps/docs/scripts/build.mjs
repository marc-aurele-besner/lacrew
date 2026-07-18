/**
 * Minimal static HTML docs builder (PRD F1.14).
 * Not Fumadocs yet — emits browsable HTML + copied markdown under dist/.
 */

import {
  cpSync,
  mkdirSync,
  existsSync,
  watch,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, dirname, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const content = join(root, "content");
const dist = join(root, "dist");

function walkMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkMarkdown(full, out);
    else if (extname(name) === ".md") out.push(full);
  }
  return out;
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Tiny markdown → HTML (headings, lists, code, links, paragraphs). */
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let inUl = false;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeUl = () => {
    if (inUl) {
      html.push("</ul>");
      inUl = false;
    }
  };
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, text, href) => {
          const h = href.endsWith(".md") ? href.replace(/\.md$/, ".html") : href;
          return `<a href="${h}">${text}</a>`;
        },
      );

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushPara();
      closeUl();
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeUl();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeUl();
      const n = h[1].length;
      html.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeUl();
      html.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ""))}</p></blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!inUl) {
        html.push("<ul>");
        inUl = true;
      }
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeUl();
    para.push(line.trim());
  }
  flushPara();
  closeUl();
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

function pageShell(title, navHtml, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · LaCrew docs</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1419; --fg: #e7ecf1; --muted: #9aa7b5; --accent: #6ec6a8; --border: #243040; --panel: #161d26; }
    @media (prefers-color-scheme: light) {
      :root { --bg: #f6f8fa; --fg: #1a2330; --muted: #5b6b7c; --accent: #0d7a5f; --border: #d0d7de; --panel: #fff; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
    .layout { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid var(--border); background: var(--panel); padding: 1.25rem 1rem; }
    aside a { display: block; color: var(--muted); text-decoration: none; padding: 0.25rem 0; font-size: 0.92rem; }
    aside a:hover, aside a.active { color: var(--accent); }
    main { padding: 2rem clamp(1rem, 4vw, 3rem); max-width: 52rem; }
    h1,h2,h3 { line-height: 1.25; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    pre { background: var(--panel); border: 1px solid var(--border); padding: 1rem; overflow: auto; border-radius: 8px; }
    a { color: var(--accent); }
    blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
    .brand { font-weight: 700; color: var(--fg); margin-bottom: 1rem; display: block; text-decoration: none; }
    @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <a class="brand" href="./index.html">LaCrew docs</a>
      ${navHtml}
    </aside>
    <main>${bodyHtml}</main>
  </div>
</body>
</html>
`;
}

function build() {
  mkdirSync(dist, { recursive: true });
  if (existsSync(content)) {
    cpSync(content, join(dist, "content"), { recursive: true });
  }

  const files = walkMarkdown(content);
  const entries = files.map((full) => {
    const rel = relative(content, full);
    const href = rel.replace(/\.md$/, ".html").split("/").join("/");
    const title =
      readFileSync(full, "utf8")
        .split("\n")
        .find((l) => l.startsWith("# "))
        ?.replace(/^#\s+/, "")
        ?.trim() || basename(full, ".md");
    return { full, rel, href, title };
  });

  for (const entry of entries) {
    const md = readFileSync(entry.full, "utf8");
    const depth = entry.rel.split("/").length - 1;
    const prefix = depth > 0 ? "../".repeat(depth) : "./";
    const navHtml = entries
      .map((e) => {
        const active = e.href === entry.href ? ' class="active"' : "";
        return `<a href="${prefix}${e.href}"${active}>${escapeHtml(e.title)}</a>`;
      })
      .join("\n");
    const outPath = join(dist, entry.href);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, pageShell(entry.title, navHtml, mdToHtml(md)));
  }

  console.log(
    `[@lacrew/docs] Static HTML build → dist/ (${entries.length} pages) + dist/content/`,
  );
}

build();

if (process.argv.includes("--watch")) {
  watch(content, { recursive: true }, () => build());
}
