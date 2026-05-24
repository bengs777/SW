const { PrismaClient } = require("@prisma/client")

const REQUIRED_ORCHESTRATION_MIGRATION = "20260520120000_production_orchestration_hardening"
const REQUIRED_RUNTIME_MIGRATION = "20260521110000_add_product_runtime_crud"
const RUNTIME_SCHEMA_VERSION = "20260521110000"

const REQUIRED_TABLES = [
  "Product",
  "RepairAttempt",
  "PreviewSession",
  "WorkerHeartbeat",
  "OrchestrationFailure",
]

const REQUIRED_COLUMNS = {
  Product: [
    "id",
    "name",
    "description",
    "area",
    "price",
    "status",
    "ownerId",
    "createdAt",
    "updatedAt",
  ],
  GenerationJob: [
    "orchestrationState",
    "traceId",
    "workerId",
    "leaseOwner",
    "leaseExpiresAt",
    "lastHeartbeatAt",
    "retryReason",
    "retryClass",
    "recoveryCount",
    "deadLetteredAt",
    "terminatedAt",
  ],
  GenerationEvent: [
    "eventType",
    "traceId",
    "spanId",
    "parentSpanId",
    "workerId",
    "sandboxId",
    "previewId",
    "metadataJson",
    "retryCount",
    "terminationReason",
  ],
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

async function getDatabaseSchemaHealth(prisma) {
  const migrations = await prisma.$queryRawUnsafe(
    "select migration_name, finished_at from _prisma_migrations where rolled_back_at is null order by started_at desc"
  )
  const appliedMigrationNames = new Set(migrations.filter((item) => item.finished_at).map((item) => item.migration_name))
  const latestMigration = migrations.find((item) => item.finished_at)?.migration_name || null
  const databaseSchema = latestMigration?.slice(0, 14) || null
  const missingMigration = appliedMigrationNames.has(REQUIRED_ORCHESTRATION_MIGRATION)
    ? appliedMigrationNames.has(REQUIRED_RUNTIME_MIGRATION)
      ? null
      : REQUIRED_RUNTIME_MIGRATION
    : REQUIRED_ORCHESTRATION_MIGRATION

  const tables = await prisma.$queryRawUnsafe(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_name = ANY($1)",
    REQUIRED_TABLES
  )
  const existingTables = new Set(tables.map((item) => item.table_name))
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table))

  const requiredTableNames = Object.keys(REQUIRED_COLUMNS)
  const columns = await prisma.$queryRawUnsafe(
    "select table_name, column_name from information_schema.columns where table_schema = current_schema() and table_name = ANY($1)",
    requiredTableNames
  )
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
    checkedAt: new Date().toISOString(),
  }
}

async function assertPrismaClientUnderstandsRuntimeSchema(prisma) {
  await prisma.generationJob.findFirst({
    select: {
      id: true,
      orchestrationState: true,
      traceId: true,
      leaseOwner: true,
      leaseExpiresAt: true,
    },
  })

  await prisma.generationEvent.findFirst({
    select: {
      id: true,
      eventType: true,
      traceId: true,
      workerId: true,
      terminationReason: true,
    },
  })
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const health = await getDatabaseSchemaHealth(prisma)
    await assertPrismaClientUnderstandsRuntimeSchema(prisma)
    console.log(JSON.stringify(health, null, 2))

    if (!health.compatible) {
      console.error(fatalMessage(health))
      process.exitCode = 1
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error("FATAL:")
  console.error("Database schema incompatible with runtime")
  console.error("")
  console.error(error)
  process.exitCode = 1
})
