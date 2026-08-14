/**
 * GitHub Pages serves a project site under /<repo>, so the export needs that
 * prefix baked in. A custom domain (docs.lacrew.xyz) serves from the root
 * instead: build with DOCS_BASE_PATH="" once that DNS record exists.
 */
export const basePath = process.env.DOCS_BASE_PATH ?? "/lacrew";
