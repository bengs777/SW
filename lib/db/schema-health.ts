import fs from "node:fs"
import path from "node:path"
import { db } from "@/lib/db/client"
import { sql } from "drizzle-orm"

export const REQUIRED_ORCHESTRATION_MIGRATION = "20260520120000_production_orchestration_hardening"
export const REQUIRED_RUNTIME_MIGRATION = "20260521110000_add_product_runtime_crud"
export const RUNTIME_SCHEMA_VERSION = "20260521110000"

const REQUIRED_MIGRATIONS: string[] = [REQUIRED_ORCHESTRATION_MIGRATION, REQUIRED_RUNTIME_MIGRATION]

const REQUIRED_TABLES = [
  "products",
  "repair_attempts",
  "preview_sessions",
  "worker_heartbeats",
  "orchestration_failures",
] as const

const REQUIRED_COLUMNS = {
  products: [
    "id",
    "name",
    "description",
    "area",
    "price",
    "status",
    "owner_id",
    "created_at",
    "updated_at",
  ],
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
} as const

export type DatabaseSchemaHealth = {
  runtimeSchema: string
  databaseSchema: string | null
  compatible: boolean
  requiredMigration: string
  missingMigration: string | null
  missingTables: string[]
  missingColumns: string[]
  probableRootCause?: string
  checkedAt: string
}

type Db = typeof db

function journalMigrationTags(): string[] {
  try {
    const journalPath = path.join(process.cwd(), "drizzle", "meta", "_journal.json")
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> }
    return journal.entries.map((entry) => entry.tag)
  } catch {
    return []
  }
}

export async function getDatabaseSchemaHealth(database: Db = db): Promise<DatabaseSchemaHealth> {
  const checkedAt = new Date().toISOString()
  let appliedMigrations = new Set<string>()
  let migrationLookupFailed = false
  try {
    const migrations = await database.all(sql`
      select migration_name, finished_at from __drizzle_migrations where rolled_back_at is null order by started_at desc
    `) as unknown as Array<{ migration_name: string; finished_at: Date | null }>
    appliedMigrations = new Set(
      migrations.filter((item) => item.finished_at).map((item) => item.migration_name)
    )
  } catch {
    migrationLookupFailed = true
  }

  const latestMigration = [...appliedMigrations][0] || null
  const databaseSchema = latestMigration?.slice(0, 14) || null

  const journalTags = journalMigrationTags()
  const journalSatisfied = journalTags.length > 0 && journalTags.every((tag) => appliedMigrations.has(tag))
  const legacySatisfied = REQUIRED_MIGRATIONS.every((name) => appliedMigrations.has(name))
  const migrationLookupSatisfied = !migrationLookupFailed && (journalSatisfied || legacySatisfied)

  let missingMigration: string | null = null
  if (!migrationLookupSatisfied) {
    const required = journalTags.length > 0 ? journalTags : REQUIRED_MIGRATIONS
    missingMigration = required.find((name) => !appliedMigrations.has(name)) || null
    if (migrationLookupFailed) missingMigration = required[0] || "migration_tracking_table_missing"
  }

  const tables = await database.all(sql`
    select name as table_name from sqlite_master where type = 'table' and name in (${sql.raw(REQUIRED_TABLES.map(t => `'${t}'`).join(','))})
  `) as unknown as Array<{ table_name: string }>
  const existingTables = new Set(tables.map((item) => item.table_name))
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table))

  const tableNames = Object.keys(REQUIRED_COLUMNS)
  const columns = [] as Array<{ table_name: string; column_name: string }>
  for (const tableName of tableNames) {
    const tableColumns = await database.all(sql`
      select name as column_name from pragma_table_info(${tableName})
    `) as unknown as Array<{ column_name: string }>
    for (const col of tableColumns) {
      columns.push({ table_name: tableName, column_name: col.column_name })
    }
  }
  const existingColumns = new Set(columns.map((item) => `${item.table_name}.${item.column_name}`))
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columnNames]) =>
    columnNames
      .filter((column) => !existingColumns.has(`${table}.${column}`))
      .map((column) => `${table}.${column}`)
  )

  const compatible = !missingMigration && missingTables.length === 0 && missingColumns.length === 0
  return {
    runtimeSchema: RUNTIME_SCHEMA_VERSION,
    databaseSchema,
    compatible,
    requiredMigration: REQUIRED_RUNTIME_MIGRATION,
    missingMigration,
    missingTables,
    missingColumns,
    ...(compatible ? {} : { probableRootCause: "database schema mismatch" }),
    checkedAt,
  }
}

export async function assertDatabaseSchemaCompatible(database: Db = db) {
  const health = await getDatabaseSchemaHealth(database)
  if (health.compatible) return health

  const details = [
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
  const error = new Error(details)
  error.name = "DatabaseSchemaIncompatibleError"
  throw error
}
