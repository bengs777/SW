const fs = require("node:fs")
const path = require("path")

const root = process.cwd()
const SCHEMA_FILE = path.join(root, "src", "lib", "db", "schema.ts")
const MIGRATIONS_DIR = path.join(root, "drizzle")

const REQUIRED_TABLES = [
  "products",
  "repair_attempts",
  "preview_sessions",
  "worker_heartbeats",
  "orchestration_failures",
]

const REQUIRED_COLUMNS = {
  products: ["id", "name", "description", "area", "price", "status", "owner_id", "created_at", "updated_at"],
  generation_jobs: [
    "orchestration_state",
    "trace_id",
    "worker_id",
    "lease_owner",
    "lease_expires_at",
    "last_heartbeat_at",
    "retry_reason",
    "retry_class",
    "recovery_count",
    "dead_lettered_at",
    "terminated_at",
  ],
  generation_events: [
    "event_type",
    "trace_id",
    "span_id",
    "parent_span_id",
    "worker_id",
    "sandbox_id",
    "preview_id",
    "metadata_json",
    "retry_count",
    "termination_reason",
  ],
}

const LEGACY_REQUIRED_MIGRATIONS = [
  "20260520120000_production_orchestration_hardening",
  "20260521110000_add_product_runtime_crud",
]

function loadEnv() {
  try {
    const { loadEnvConfig } = require("@next/env")
    loadEnvConfig(root)
  } catch {
    // optional
  }
}

function isStrictPreflight() {
  return (
    process.env.SWIFT_STRICT_SCHEMA_HEALTH === "true" ||
    process.env.VERCEL === "1" ||
    process.env.CI === "true"
  )
}

function journalTags() {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"))
    return journal.entries.map((entry) => entry.tag)
  } catch {
    return []
  }
}

function parseSchemaTables() {
  const source = fs.readFileSync(SCHEMA_FILE, "utf8")
  const tables = new Map()
  const tablePattern = /sqliteTable\(\s*"([^"]+)"\s*,\s*\{/g
  let match
  while ((match = tablePattern.exec(source))) {
    const tableName = match[1]
    let depth = 1
    let index = tablePattern.lastIndex
    while (index < source.length && depth > 0) {
      const char = source[index]
      if (char === "{") depth += 1
      if (char === "}") depth -= 1
      index += 1
    }
    const body = source.slice(tablePattern.lastIndex, index - 1)
    const columns = new Set()
    const columnPattern = /(\w+)\s*:\s*\w+(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g
    let columnMatch
    while ((columnMatch = columnPattern.exec(body))) {
      columns.add(columnMatch[2])
    }
    tables.set(tableName, columns)
    tablePattern.lastIndex = index
  }
  return tables
}

function fatalMessage(health) {
  return [
    "FATAL:",
    "Database schema incompatible with runtime",
    "",
    "Missing migration:",
    health.missingMigration || "none",
    "",
    "Missing tables:",
    ...(health.missingTables.length ? health.missingTables.map((table) => `- ${table}`) : ["none"]),
    "",
    "Missing columns:",
    ...(health.missingColumns.length ? health.missingColumns.map((column) => `- ${column}`) : ["none"]),
  ].join("\n")
}

async function assertRuntimeSchemaQueries(client, schemaTables) {
  const probes = [
    ["generation_jobs", ["id", "orchestration_state", "trace_id", "lease_owner", "lease_expires_at"]],
    ["generation_events", ["id", "event_type", "trace_id", "worker_id", "termination_reason"]],
    ["usage_logs", ["id", "status", "cost"]],
    ["billing_transactions", ["id", "amount", "direction"]],
  ]
  for (const [table, columns] of probes) {
    if (!schemaTables.has(table)) continue
    await client.execute(`select ${columns.join(", ")} from ${table} limit 1`)
  }
}

async function getDatabaseSchemaHealth(client) {
  const schemaTables = parseSchemaTables()

  const master = await client.execute("select name from sqlite_master where type = 'table'")
  const existingTables = new Set(master.rows.map((row) => String(row.name)))
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table))

  const missingColumns = []
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!existingTables.has(tableName)) continue
    const info = await client.execute(`PRAGMA table_info(${tableName})`)
    const existing = new Set(info.rows.map((row) => String(row.name)))
    for (const column of requiredColumns) {
      if (!existing.has(column)) missingColumns.push(`${tableName}.${column}`)
    }
  }

  let missingMigration = null
  let appliedMigrations = []
  if (existingTables.has("__drizzle_migrations")) {
    try {
      const rows = await client.execute(
        "select migration_name, finished_at from __drizzle_migrations where rolled_back_at is null order by started_at desc"
      )
      appliedMigrations = rows.rows
        .filter((row) => row.finished_at !== null && row.finished_at !== undefined)
        .map((row) => String(row.migration_name))
      const applied = new Set(appliedMigrations)
      const journal = journalTags()
      const journalSatisfied = journal.length > 0 && journal.every((name) => applied.has(name))
      const legacySatisfied = LEGACY_REQUIRED_MIGRATIONS.every((name) => applied.has(name))
      if (!journalSatisfied && !legacySatisfied) {
        const required = journal.length > 0 ? journal : LEGACY_REQUIRED_MIGRATIONS
        missingMigration = required.find((name) => !applied.has(name)) || null
      }
    } catch {
      missingMigration = journalTags()[0] || "migration_tracking_table_invalid"
    }
  } else {
    missingMigration = journalTags()[0] || "migration_tracking_table_missing"
  }

  await assertRuntimeSchemaQueries(client, schemaTables)

  const compatible = !missingMigration && missingTables.length === 0 && missingColumns.length === 0
  return {
    runtimeSchema: "drizzle-sqlite",
    databaseSchema: appliedMigrations[0] || null,
    compatible,
    requiredMigration: LEGACY_REQUIRED_MIGRATIONS[LEGACY_REQUIRED_MIGRATIONS.length - 1],
    missingMigration,
    missingTables,
    missingColumns,
    ...(compatible ? {} : { probableRootCause: "database schema mismatch" }),
    checkedAt: new Date().toISOString(),
  }
}

async function main() {
  loadEnv()

  const url = process.env.TURSO_DATABASE_URL
  if (!url) {
    if (isStrictPreflight()) {
      console.error("FATAL:")
      console.error("TURSO_DATABASE_URL is required for schema health checks in strict mode")
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify({ compatible: null, status: "skipped", reason: "missing_env" }, null, 2))
    return
  }

  const { createClient } = require("@libsql/client")
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined })

  try {
    const health = await getDatabaseSchemaHealth(client)
    console.log(JSON.stringify(health, null, 2))
    if (!health.compatible) {
      console.error(fatalMessage(health))
      process.exitCode = 1
    }
  } finally {
    client.close()
  }
}

main().catch((error) => {
  const message = error?.message || String(error)
  if (!isStrictPreflight() && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|timed out|timeout/i.test(message)) {
    console.log(JSON.stringify({ compatible: null, status: "skipped", reason: "database_unreachable" }, null, 2))
    return
  }
  console.error("FATAL:")
  console.error("Database schema incompatible with runtime")
  console.error("")
  console.error(error)
  process.exitCode = 1
})
