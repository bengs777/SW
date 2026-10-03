import { defineConfig } from "drizzle-kit"

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url) {
  throw new Error("TURSO_DATABASE_URL is required to run drizzle-kit commands.")
}

export default defineConfig({
  dialect: "turso",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url,
    authToken: authToken || undefined,
  },
  strict: true,
  verbose: true,
})
