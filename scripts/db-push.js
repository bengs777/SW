const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const REQUIRED_TABLES = [
  "User",
  "Workspace",
  "WorkspaceMember",
  "Project",
  "GenerationJob",
  "GenerationEvent",
  "GenerationAttempt",
  "GenerationQualityMetric",
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
        .replace(/\bCREATE TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ")
        .replace(/\bCREATE UNIQUE INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
        .replace(/\bCREATE INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ")
    )
}

function isCreateTableStatement(statement) {
  return /^CREATE TABLE\b/i.test(statement)
}

function isIndexStatement(statement) {
  return /^CREATE (?:UNIQUE )?INDEX\b/i.test(statement)
}

async function listTables(client) {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  )

  return result.rows.map((row) => String(row.name))
}

async function listColumns(client, tableName) {
  const result = await client.execute(`PRAGMA table_info("${tableName}")`)
  return new Set(result.rows.map((row) => String(row.name)))
}

async function ensureGenerationJobColumns(client) {
  const existingColumns = await listColumns(client, "GenerationJob")
  const columnStatements = [
    ["version", 'ALTER TABLE "GenerationJob" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0'],
    ["retryCount", 'ALTER TABLE "GenerationJob" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0'],
    ["maxRetries", 'ALTER TABLE "GenerationJob" ADD COLUMN "maxRetries" INTEGER NOT NULL DEFAULT 2'],
    ["attemptCount", 'ALTER TABLE "GenerationJob" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0'],
    ["contextJson", 'ALTER TABLE "GenerationJob" ADD COLUMN "contextJson" TEXT'],
    ["diagnosticsJson", 'ALTER TABLE "GenerationJob" ADD COLUMN "diagnosticsJson" TEXT'],
    ["metricsJson", 'ALTER TABLE "GenerationJob" ADD COLUMN "metricsJson" TEXT'],
    ["previewUrl", 'ALTER TABLE "GenerationJob" ADD COLUMN "previewUrl" TEXT'],
    ["queueJobId", 'ALTER TABLE "GenerationJob" ADD COLUMN "queueJobId" TEXT'],
    ["idempotencyKey", 'ALTER TABLE "GenerationJob" ADD COLUMN "idempotencyKey" TEXT'],
    ["requestHash", 'ALTER TABLE "GenerationJob" ADD COLUMN "requestHash" TEXT'],
    ["timedOutAt", 'ALTER TABLE "GenerationJob" ADD COLUMN "timedOutAt" DATETIME'],
  ]

  for (const [columnName, statement] of columnStatements) {
    if (existingColumns.has(columnName)) {
      continue
    }

    console.log(`[db-push] Adding missing GenerationJob column: ${columnName}`)
    await client.execute(statement)
  }

  await client.execute('CREATE INDEX IF NOT EXISTS "GenerationJob_queueJobId_idx" ON "GenerationJob"("queueJobId")')
}

async function assertNoDuplicateGenerationJobKey(client, columnName) {
  const columns = await listColumns(client, "GenerationJob")
  if (!columns.has(columnName)) {
    return
  }

  const result = await client.execute(`
    SELECT "userId", "projectId", "${columnName}", COUNT(*) AS "count"
    FROM "GenerationJob"
    WHERE "${columnName}" IS NOT NULL AND trim("${columnName}") <> ''
    GROUP BY "userId", "projectId", "${columnName}"
    HAVING COUNT(*) > 1
    LIMIT 20
  `)

  if (result.rows.length === 0) {
    return
  }

  const details = result.rows
    .map((row) => `${row.userId}/${row.projectId}/${row[columnName]} (${row.count} rows)`)
    .join(", ")

  throw new Error(
    `Duplicate GenerationJob ${columnName} values found. Resolve these before creating the production unique index: ${details}`
  )
}

async function ensureGenerationJobDedupeIndexes(client) {
  await assertNoDuplicateGenerationJobKey(client, "idempotencyKey")
  await assertNoDuplicateGenerationJobKey(client, "requestHash")
  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS "GenerationJob_userId_projectId_idempotencyKey_key" ON "GenerationJob"("userId", "projectId", "idempotencyKey")'
  )
  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS "GenerationJob_userId_projectId_requestHash_key" ON "GenerationJob"("userId", "projectId", "requestHash")'
  )
}

async function ensureGenerationHistoryDedupeIndex(client) {
  const tables = await listTables(client)
  if (!tables.includes("GenerationHistory")) {
    return
  }

  const columns = await listColumns(client, "GenerationHistory")
  if (!columns.has("idempotencyKey")) {
    return
  }

  const result = await client.execute(`
    SELECT "projectId", "idempotencyKey", COUNT(*) AS "count"
    FROM "GenerationHistory"
    WHERE "idempotencyKey" IS NOT NULL AND trim("idempotencyKey") <> ''
    GROUP BY "projectId", "idempotencyKey"
    HAVING COUNT(*) > 1
    LIMIT 20
  `)

  if (result.rows.length > 0) {
    const details = result.rows
      .map((row) => `${row.projectId}/${row.idempotencyKey} (${row.count} rows)`)
      .join(", ")

    throw new Error(
      `Duplicate GenerationHistory idempotency keys found. Resolve these before creating the production unique index: ${details}`
    )
  }

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS "GenerationHistory_projectId_idempotencyKey_key" ON "GenerationHistory"("projectId", "idempotencyKey")'
  )
}

async function pushLocalDatabase() {
  env.DATABASE_URL = process.env.SWIFT_LOCAL_DATABASE_URL || "file:./dev.db"
  env.TURSO_DATABASE_URL = process.env.SWIFT_LOCAL_TURSO_DATABASE_URL || "file:./prisma/dev.db"

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
  const tableStatements = statements.filter(isCreateTableStatement)
  const indexStatements = statements.filter(isIndexStatement)
  const otherStatements = statements.filter((statement) => !isCreateTableStatement(statement) && !isIndexStatement(statement))

  for (const statement of tableStatements) {
    await client.execute(statement)
  }

  await ensureGenerationJobColumns(client)
  await ensureGenerationJobDedupeIndexes(client)
  await ensureGenerationHistoryDedupeIndex(client)

  for (const statement of [...otherStatements, ...indexStatements]) {
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
