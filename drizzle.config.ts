import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/glance" },
  // The WhatsApp bot shares the database and creates its own bot_* tables; push must never rename or drop them.
  tablesFilter: ["!bot_*"],
});
