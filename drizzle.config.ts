import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: (globalThis as typeof globalThis & { process: { env: Record<string, string | undefined> } }).process.env.DATABASE_URL!,
  },
});
