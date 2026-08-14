import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Static export: the whole index ships as a file the client downloads once.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, {
  language: "english",
});
