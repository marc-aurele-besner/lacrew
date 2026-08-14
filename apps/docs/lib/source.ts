import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";

// `content/` holds the hand-written pages; `content/reference/` is TypeDoc
// output and `content/spec.md` is the repo's SPEC.md, both written by
// `scripts/prepare-content.mjs` before the build.
const docs = defineDocs({
  dir: "content",
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

// Pages sit at the site root (`/spec`, `/protocol/overview`) rather than under
// a `/docs` prefix, so the URLs the site already published keep resolving.
export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});
