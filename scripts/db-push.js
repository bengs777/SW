const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const REQUIRED_TABLES = [
  "User",
  "Workspace",
  "WorkspaceMember",
  "Project",
  "UsageLog",
  "BillingTransaction",
  "Subscription",
]

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env")
  if (!fs.existsSync(envPath)) {
    return
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmed.indexOf("=")
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    const value = rawValue.replace(/^["']|["']$/g, "")

    if (key && !process.env[key]) {
      process.env[key] = value
    }
  }
}

loadDotEnv()

const target = process.argv[2] || "local"
const env = { ...process.env }

function getCreateSchemaSql() {
  const diffEnv = {
    ...env,
    DATABASE_URL: "file:./dev.db",
  }

  return execSync(
    "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
    {
      env: diffEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) =>
      statement
        .replace(/^CREATE TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ")
        .replace(/^CREATE UNIQUE INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replace(/^CREATE INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ")
    )
}

async function listTables(client) {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  )

  return result.rows.map((row) => String(row.name))
}

async function pushLocalDatabase() {
  env.DATABASE_URL = process.env.DATABASE_URL || "file:./dev.db"

  const output = execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (output) {
    process.stdout.write(output)
  }
}

async function pushTursoDatabase() {
  if (!process.env.TURSO_DATABASE_URL) {
    console.error("[db-push] TURSO_DATABASE_URL is required for production database sync.")
    process.exit(1)
  }

  const { createClient } = require("@libsql/client")
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  })

  const beforeTables = await listTables(client)
  const beforeTableSet = new Set(beforeTables)
  const missingBefore = REQUIRED_TABLES.filter((table) => !beforeTableSet.has(table))

  if (missingBefore.length === 0) {
    console.log("[db-push] Production database already has the required application tables; syncing indexes and constraints.")
  } else {
    console.log(`[db-push] Creating missing production tables: ${missingBefore.join(", ")}`)
  }

  const sql = getCreateSchemaSql()
  const statements = splitSqlStatements(sql)

  for (const statement of statements) {
    await client.execute(statement)
  }

  const afterTables = await listTables(client)
  const afterTableSet = new Set(afterTables)
  const missingAfter = REQUIRED_TABLES.filter((table) => !afterTableSet.has(table))

  if (missingAfter.length > 0) {
    throw new Error(
      `Production database is still missing required tables: ${missingAfter.join(", ")}`
    )
  }

  console.log("[db-push] Production database schema bootstrap completed.")
}

(async () => {
  if (target === "local") {
    await pushLocalDatabase()
    return
  }

  if (target === "prod" || target === "production") {
    await pushTursoDatabase()
    return
  }

  console.error("[db-push] Usage: node scripts/db-push.js local|prod")
  process.exit(1)
})().catch((error) => {
  const message = [error?.message, error?.stdout, error?.stderr]
    .map((value) => {
      if (Buffer.isBuffer(value)) {
        return value.toString("utf8")
      }

      return String(value || "")
    })
    .join("\n")

  console.error(`[db-push] Failed to sync ${target} database.`)
  console.error(message)
  process.exit(1)
})
