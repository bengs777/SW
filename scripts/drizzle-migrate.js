const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()
const MIGRATIONS_DIR = path.join(root, "drizzle")
const TRACKING_TABLE = "__drizzle_migrations"
const COLUMN_TYPES = {
  migration_name: "text",
  started_at: "integer",
  finished_at: "integer",
  rolled_back_at: "integer",
  hash: "text",
}
const MAX_ATTEMPTS = 3

function loadEnv() {
  try {
    const { loadEnvConfig } = require("@next/env")
    loadEnvConfig(root)
  } catch {
    // fallback handled below
  }
}

function isStrictPreflight() {
  return (
    process.env.SWIFT_STRICT_MIGRATIONS === "true" ||
    process.env.VERCEL === "1" ||
    process.env.CI === "true"
  )
}

function classifyMigrationFailure(error) {
  const text = String([error?.message, error?.stdout, error?.stderr, error?.code].filter(Boolean).join(" ")).trim()
  if (!text) return "migration_failed"
  if (/TURSO_DATABASE_URL is required|missing.*DATABASE_URL/i.test(text)) return "missing_env"
  if (/invalid.*url|unsupported.*url|libsql:\/\/|https?:\/\/.*invalid/i.test(text) && /url/i.test(text)) {
    return "invalid_database_url"
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket|can't reach|cannot reach|timed out|timeout|503|502|429/i.test(text)) {
    return "database_unreachable"
  }
  if (/no such table|no such column|already exists|syntax error|NOT NULL constraint|UNIQUE constraint/i.test(text)) {
    return "schema_failure"
  }
  return "migration_failed"
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJournal() {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json")
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
  return [...journal.entries].sort((a, b) => a.idx - b.idx)
}

async function ensureTrackingColumns(client) {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      id integer PRIMARY KEY AUTOINCREMENT,
      hash text,
      migration_name text,
      started_at integer,
      finished_at integer,
      rolled_back_at integer
    )`
  )

  const tableInfo = await client.execute(`PRAGMA table_info(${TRACKING_TABLE})`)
  const existing = new Set(tableInfo.rows.map((row) => String(row.name)))

  for (const [column, type] of Object.entries(COLUMN_TYPES)) {
    if (!existing.has(column)) {
      await client.execute(`ALTER TABLE ${TRACKING_TABLE} ADD COLUMN ${column} ${type}`)
    }
  }
}

async function appliedMigrations(client) {
  const result = await client.execute(
    `SELECT migration_name, finished_at FROM ${TRACKING_TABLE} WHERE rolled_back_at IS NULL`
  )
  return new Set(
    result.rows
      .filter((row) => row.finished_at !== null && row.finished_at !== undefined)
      .map((row) => String(row.migration_name))
  )
}

function readMigrationStatements(tag) {
  const file = path.join(MIGRATIONS_DIR, `${tag}.sql`)
  if (!fs.existsSync(file)) {
    throw new Error(`migration file not found: drizzle/${tag}.sql`)
  }
  return fs
    .readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function tablesCreatedBy(statements) {
  const tables = []
  for (const statement of statements) {
    const match = statement.match(/CREATE TABLE (?:IF NOT EXISTS )?[`"]?(\w+)/i)
    if (match) tables.push(match[1])
  }
  return tables
}

async function runMigrations() {
  const { createClient } = require("@libsql/client")
  const url = process.env.TURSO_DATABASE_URL
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined })

  await ensureTrackingColumns(client)
  const applied = await appliedMigrations(client)
  const entries = readJournal()

  const master = await client.execute("select name from sqlite_master where type = 'table'")
  const existingTables = new Set(master.rows.map((row) => String(row.name)))

  const results = []
  for (const entry of entries) {
    const tag = entry.tag
    if (applied.has(tag)) {
      results.push({ tag, status: "already_applied" })
      continue
    }
    const statements = readMigrationStatements(tag)
    const createdTables = tablesCreatedBy(statements)
    const baselineApplied = createdTables.length > 0 && createdTables.every((table) => existingTables.has(table))

    if (!baselineApplied) {
      const startedAt = Date.now()
      for (const statement of statements) {
        await client.execute(statement)
      }
      await client.execute({
        sql: `INSERT INTO ${TRACKING_TABLE} (migration_name, started_at, finished_at) VALUES (?, ?, ?)`,
        args: [tag, startedAt, Date.now()],
      })
      results.push({ tag, status: "applied", statements: statements.length })
      continue
    }

    await client.execute({
      sql: `INSERT INTO ${TRACKING_TABLE} (migration_name, started_at, finished_at) VALUES (?, ?, ?)`,
      args: [tag, Date.now(), Date.now()],
    })
    results.push({ tag, status: "recorded_baseline", tables: createdTables.length })
  }

  return results
}

async function statusOnly() {
  const url = process.env.TURSO_DATABASE_URL
  if (!url) {
    console.error("[drizzle-migrate] status=missing_env TURSO_DATABASE_URL is required for --status")
    process.exitCode = 1
    return
  }

  const { createClient } = require("@libsql/client")
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined })

  try {
    await ensureTrackingColumns(client)
    const applied = await appliedMigrations(client)
    const entries = readJournal()
    const pending = entries.filter((entry) => !applied.has(entry.tag)).map((entry) => entry.tag)

    if (pending.length > 0) {
      console.error(`[drizzle-migrate] status=pending pending=${JSON.stringify(pending)}`)
      process.exitCode = 1
      return
    }

    console.log(`[drizzle-migrate] status=ok pending=0 journal=${entries.length}`)
  } catch (error) {
    console.error(`[drizzle-migrate] status=failed message=${error?.message || error}`)
    process.exitCode = 1
  } finally {
    try {
      client.close()
    } catch {
      // ignore close errors
    }
  }
}

async function main() {
  loadEnv()

  if (process.argv.includes("--status")) {
    await statusOnly()
    return
  }

  const url = process.env.TURSO_DATABASE_URL
  if (!url) {
    if (isStrictPreflight()) {
      console.error("[drizzle-migrate] status=missing_env TURSO_DATABASE_URL is required in strict mode")
      process.exitCode = 1
      return
    }
    console.log("[drizzle-migrate] status=skipped reason=missing_env (local fallback)")
    return
  }

  let lastFailure = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const results = await runMigrations()
      console.log(`[drizzle-migrate] status=ok results=${JSON.stringify(results)}`)
      return
    } catch (error) {
      lastFailure = error
      const kind = classifyMigrationFailure(error)
      console.error(`[drizzle-migrate] status=error attempt=${attempt} kind=${kind} message=${error?.message || error}`)
      if (kind === "database_unreachable" && attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 500)
        continue
      }
      if (kind === "database_unreachable" && !isStrictPreflight()) {
        console.log("[drizzle-migrate] status=skipped reason=database_unreachable (local fallback)")
        return
      }
      break
    }
  }

  const kind = classifyMigrationFailure(lastFailure)
  console.error(`[drizzle-migrate] status=failed kind=${kind}`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error("[drizzle-migrate] status=failed", error)
  process.exitCode = 1
})
