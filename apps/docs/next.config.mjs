import { createMDX } from "fumadocs-mdx/next";
import { basePath } from "./base-path.mjs";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  basePath,
  // Every route exports as `<slug>/index.html`. GitHub Pages redirects a bare
  // `/slug` to `/slug/` whenever the directory exists, so the directory has to
  // be the thing that holds the page.
  trailingSlash: true,
  reactStrictMode: true,
  // next/link applies basePath on its own; the search client fetches its index
  // by hand, so it needs the prefix as a value.
  env: { NEXT_PUBLIC_DOCS_BASE_PATH: basePath },
  images: { unoptimized: true },
};

export default withMDX(config);
