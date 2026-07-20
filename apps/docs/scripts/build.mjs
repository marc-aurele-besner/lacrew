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

/** Markdown → plain text for the search index (code blocks dropped). */
function mdToPlainText(md) {
  const noCode = md.replace(/```[\s\S]*?```/g, " ");
  return noCode
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pageShell(title, navHtml, bodyHtml, prefix) {
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
    #docs-search { width: 100%; margin-bottom: 0.75rem; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; font-size: 0.88rem; }
    #docs-results a { display: block; padding: 0.3rem 0.4rem; border-radius: 6px; font-size: 0.85rem; }
    #docs-results a:hover { background: var(--bg); }
    #docs-results .snippet { display: block; color: var(--muted); font-size: 0.75rem; }
    @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <a class="brand" href="./index.html">LaCrew docs</a>
      <input id="docs-search" type="search" placeholder="Search docs…" autocomplete="off" />
      <div id="docs-results"></div>
      ${navHtml}
    </aside>
    <main>${bodyHtml}</main>
  </div>
  <script>
    (function () {
      var input = document.getElementById("docs-search");
      var out = document.getElementById("docs-results");
      if (!input || !out) return;
      var index = null;
      function load() {
        if (index) return Promise.resolve(index);
        return fetch("${prefix}search-index.json")
          .then(function (r) { return r.json(); })
          .then(function (data) { index = data; return data; })
          .catch(function () { return []; });
      }
      function snippet(text, q) {
        var i = text.toLowerCase().indexOf(q);
        if (i < 0) return text.slice(0, 90);
        var start = Math.max(0, i - 30);
        return (start > 0 ? "…" : "") + text.slice(start, i + q.length + 60) + "…";
      }
      input.addEventListener("input", function () {
        var q = input.value.trim().toLowerCase();
        if (q.length < 2) { out.innerHTML = ""; return; }
        load().then(function (entries) {
          var scored = entries
            .map(function (e) {
              var t = e.title.toLowerCase();
              var score = 0;
              if (t.indexOf(q) >= 0) score += 5;
              var occurrences = e.text.toLowerCase().split(q).length - 1;
              score += Math.min(occurrences, 4);
              return { e: e, score: score };
            })
            .filter(function (x) { return x.score > 0; })
            .sort(function (a, b) { return b.score - a.score; })
            .slice(0, 8);
          out.innerHTML = scored
            .map(function (x) {
              return '<a href="${prefix}' + x.e.href + '">' + x.e.title +
                '<span class="snippet">' + snippet(x.e.text, q) + "</span></a>";
            })
            .join("");
        });
      });
    })();
  </script>
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
    writeFileSync(outPath, pageShell(entry.title, navHtml, mdToHtml(md), prefix));
  }

  const searchIndex = entries.map((entry) => ({
    title: entry.title,
    href: entry.href,
    text: mdToPlainText(readFileSync(entry.full, "utf8")).slice(0, 4000),
  }));
  writeFileSync(join(dist, "search-index.json"), JSON.stringify(searchIndex));

  console.log(
    `[@lacrew/docs] Static HTML build → dist/ (${entries.length} pages) + dist/content/`,
  );
}

build();

if (process.argv.includes("--watch")) {
  watch(content, { recursive: true }, () => build());
}
