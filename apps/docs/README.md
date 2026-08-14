# @lacrew/docs

The public docs site: [Fumadocs](https://fumadocs.dev) over the markdown in
`content/`, exported as static HTML and deployed to GitHub Pages by
`.github/workflows/docs.yml`.

```bash
pnpm --filter @lacrew/docs dev     # http://localhost:3000/lacrew
pnpm --filter @lacrew/docs build   # → out/
```

## Where the pages come from

| Source                                         | Checked in | Becomes                                  |
| ---------------------------------------------- | ---------- | ---------------------------------------- |
| `content/*.md`, `content/protocol/*.md`        | yes        | `/self-host`, `/protocol/…`              |
| the repo's root `SPEC.md`                      | no         | `/spec`                                  |
| TypeDoc over `@lacrew/sdk` and `@lacrew/flows` | no         | `/reference/sdk/…`, `/reference/flows/…` |

`pnpm content` (run by both `dev` and `build`) generates the last two:
`typedoc` writes `content/reference/`, then `scripts/prepare-content.mjs` gives
every generated page the frontmatter, titles, and link shape Fumadocs expects.
Both outputs are gitignored — edit the source, not the generated page.

A new hand-written page needs frontmatter with a `title`, and an entry in
`content/meta.json` to place it in the sidebar.

## What the deploy expects

- Pages serves this repo's site under `/lacrew`, so `basePath` defaults to that
  (see `base-path.mjs`). Build with `DOCS_BASE_PATH=""` for a root-served
  custom domain such as `docs.lacrew.xyz`.
- Routes export as `<slug>/index.html`, because Pages redirects `/slug` to
  `/slug/` whenever the directory exists. `scripts/postbuild.mjs` then writes a
  `<slug>.html` redirect for every page so the `/spec.html` style URLs the site
  published before this layout keep working, plus `.nojekyll` (without it Pages
  drops `_next/`) and `CNAME`.
- Search is the static Orama index at `out/api/search`, downloaded by the
  client on first search — no server, and it covers the generated reference too.
