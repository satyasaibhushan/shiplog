import { defineConfig } from "drizzle-kit";
import { join } from "path";
import { homedir } from "os";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: join(homedir(), ".shiplog", "cache.sqlite"),
  },
});
