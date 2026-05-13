const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production")

const target = process.argv[2] || (process.env.NODE_ENV === "production" ? "production" : "local")

function value(...keys) {
  for (const key of keys) {
    const current = process.env[key]
    if (current && current.trim()) {
      return current.trim()
    }
  }

  return ""
}

function assertPostgresUrl(key, current) {
  if (!/^postgres(?:ql)?:\/\//i.test(current || "")) {
    throw new Error(`[db] ${key} must be a PostgreSQL connection string.`)
  }
}

function hasMigrations() {
  const migrationsDir = path.join(process.cwd(), "prisma", "migrations")
  if (!fs.existsSync(migrationsDir)) return false

  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && fs.existsSync(path.join(migrationsDir, entry.name, "migration.sql")))
}

function run(command, env) {
  execSync(command, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  })
}

function syncDevelopmentDatabase() {
  const databaseUrl = value("DATABASE_URL")
  assertPostgresUrl("DATABASE_URL", databaseUrl)

  run("npx prisma db push --skip-generate", {
    DATABASE_URL: databaseUrl,
  })
}

function deployProductionMigrations() {
  const directDatabaseUrl = value("DIRECT_DATABASE_URL", "DIRECT_URL", "POSTGRES_URL_NON_POOLING")
  assertPostgresUrl("DIRECT_DATABASE_URL", directDatabaseUrl)

  if (!hasMigrations()) {
    throw new Error("[db] No Prisma migrations were found. Create and review a migration before deploying schema changes to Neon.")
  }

  run("npx prisma migrate deploy", {
    DATABASE_URL: directDatabaseUrl,
  })
}

try {
  if (target === "production" || target === "prod") {
    deployProductionMigrations()
  } else {
    syncDevelopmentDatabase()
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
