import { defineConfig } from "drizzle-kit";

/** Neon or Docker Postgres — same DATABASE_URL. */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://lacrew:lacrew@localhost:5432/lacrew",
  },
});
