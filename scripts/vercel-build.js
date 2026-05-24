const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd())

const env = { ...process.env }
env.NODE_ENV = env.NODE_ENV || "production"

const isWindows = process.platform === "win32"
const isStrictPreflight =
  process.env.SWIFT_STRICT_PRISMA_PREFLIGHT === "true" ||
  process.env.VERCEL === "1" ||
  process.env.CI === "true"
const MAX_PRISMA_GENERATE_ATTEMPTS = 3
const MAX_MIGRATE_DEPLOY_ATTEMPTS = 3
let prismaMigrationStatus = "skipped"

const prismaClientPackageJson = require.resolve("@prisma/client/package.json")
const prismaClientDir = path.resolve(path.dirname(prismaClientPackageJson), "..", "..", ".prisma", "client")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hasExistingPrismaClient = () => fs.existsSync(path.join(prismaClientDir, "index.d.ts"))

function stringifyError(error) {
  return [error?.message, error?.stdout, error?.stderr, error?.output]
    .map((value) => {
      if (Buffer.isBuffer(value)) return value.toString("utf8")
      if (Array.isArray(value)) {
        return value.map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item || ""))).join("\n")
      }
      return String(value || "")
    })
    .join("\n")
}

function classifyPrismaFailure(errorText) {
  const text = String(errorText || "")
  if (/environment variable.*DATABASE_URL|DATABASE_URL.*not found|missing.*DATABASE_URL/i.test(text)) {
    return "missing_env"
  }
  if (/P1000|P1001|P1002|P1003|can't reach database|cannot reach database|timed out|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|authentication failed/i.test(text)) {
    return "database_unreachable"
  }
  if (/schema engine error/i.test(text) && !/P1012|schema parsing|error validating|prisma schema validation|invalid model|invalid field|unknown argument/i.test(text)) {
    return "database_unreachable"
  }
  if (/invalid.*database_url|must start with the protocol|invalid.*connection string|database url.*invalid/i.test(text)) {
    return "invalid_database_url"
  }
  if (/P1012|schema parsing|error validating|prisma schema validation|invalid model|invalid field|unknown argument/i.test(text)) {
    return "schema_parsing_failure"
  }
  if (/schema engine error|query_engine|schema-engine|libquery_engine|engine binary|binary target/i.test(text)) {
    return "engine_binary_failure"
  }
  return "unknown_prisma_failure"
}

function diagnoseDatabaseUrl() {
  const value = process.env.DATABASE_URL || ""
  if (!value.trim()) {
    return {
      ok: false,
      code: "missing_env",
      message: "DATABASE_URL is missing; Prisma migrate deploy cannot run.",
    }
  }

  if (!/^postgres(?:ql)?:\/\//i.test(value.trim())) {
    return {
      ok: false,
      code: "invalid_database_url",
      message: "DATABASE_URL is not a PostgreSQL connection string.",
    }
  }

  env.DATABASE_URL = value
  return { ok: true, code: "ok", message: "DATABASE_URL is present." }
}

function emitDiagnostic(stage, diagnostic, extra = {}) {
  const payload = {
    stage,
    strict: isStrictPreflight,
    ...diagnostic,
    ...extra,
  }
  console.warn(`[vercel-build] prisma_preflight_diagnostic ${JSON.stringify(payload)}`)
}

function handlePreflightFailure(stage, diagnostic, error) {
  emitDiagnostic(stage, diagnostic, error ? { detail: stringifyError(error).slice(0, 4000) } : {})
  if (isStrictPreflight) {
    const message = diagnostic.message || diagnostic.code || "Prisma preflight failed"
    throw new Error(`[vercel-build] ${stage} failed: ${message}`)
  }
  console.warn(`[vercel-build] ${stage} skipped/continued in local fallback mode. Run deploy:preflight with a reachable database before deployment.`)
}

function emitMigrationStatus(status, diagnostic = {}) {
  prismaMigrationStatus = status
  console.warn(`[vercel-build] prismaMigrationStatus ${JSON.stringify({
    prismaMigrationStatus,
    ...diagnostic,
  })}`)
}

async function runPrismaGenerateWithRetry() {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_PRISMA_GENERATE_ATTEMPTS; attempt += 1) {
    try {
      const output = execSync("npx prisma generate", { env, encoding: "utf8" })
      if (output) process.stdout.write(output)
      return
    } catch (error) {
      lastError = error
      const errorText = stringifyError(error)
      const isEpermLock = /eperm|operation not permitted/i.test(errorText) && /query_engine|rename/i.test(errorText)

      if (isWindows && isEpermLock && attempt < MAX_PRISMA_GENERATE_ATTEMPTS) {
        const retryDelayMs = 1500 * attempt
        console.warn(`[vercel-build] prisma generate failed on attempt ${attempt}/${MAX_PRISMA_GENERATE_ATTEMPTS} due to Windows file lock, retrying in ${retryDelayMs}ms...`)
        await sleep(retryDelayMs)
        continue
      }

      if (isWindows && isEpermLock && hasExistingPrismaClient()) {
        emitDiagnostic("prisma-generate", {
          ok: false,
          code: "engine_binary_failure",
          message: "Prisma generate could not replace the Windows engine; using the existing Prisma client.",
        })
        return
      }

      const code = classifyPrismaFailure(errorText)
      const diagnostic = {
        ok: false,
        code,
        message: code === "schema_parsing_failure"
          ? "Prisma schema parsing/validation failed during generate."
          : code === "engine_binary_failure"
            ? "Prisma engine binary failed during generate."
            : "Prisma generate failed.",
      }

      if (!isStrictPreflight && hasExistingPrismaClient() && code === "engine_binary_failure") {
        handlePreflightFailure("prisma-generate", diagnostic, error)
        return
      }

      handlePreflightFailure("prisma-generate", diagnostic, error)
      return
    }
  }

  if (lastError) throw lastError
}

async function runMigrationDeployment() {
  const database = diagnoseDatabaseUrl()
  if (!database.ok) {
    emitMigrationStatus("skipped", {
      reason: database.code,
      message: database.message,
    })
    console.warn(`[vercel-build] migrate-deploy skipped: ${database.message}`)
    return false
  }

  let lastError = null
  for (let attempt = 1; attempt <= MAX_MIGRATE_DEPLOY_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[vercel-build] deploying pending Prisma migrations... (${attempt}/${MAX_MIGRATE_DEPLOY_ATTEMPTS})`)
      const output = execSync("npx prisma migrate deploy", { env, encoding: "utf8" })
      if (output) process.stdout.write(output)
      emitMigrationStatus("applied", {
        attempt,
      })
      return true
    } catch (error) {
      lastError = error
      const errorText = stringifyError(error)
      const isAdvisoryLockTimeout = /P1002|advisory lock|pg_advisory_lock/i.test(errorText)
      if (isAdvisoryLockTimeout && attempt < MAX_MIGRATE_DEPLOY_ATTEMPTS) {
        const retryDelayMs = 2500 * attempt
        console.warn(`[vercel-build] prisma migrate deploy hit advisory lock timeout on attempt ${attempt}/${MAX_MIGRATE_DEPLOY_ATTEMPTS}, retrying in ${retryDelayMs}ms...`)
        await sleep(retryDelayMs)
        continue
      }
      break
    }
  }

  if (lastError) {
    const code = classifyPrismaFailure(stringifyError(lastError))
    const diagnostic = {
      ok: false,
      code,
      message: code === "engine_binary_failure"
        ? "Prisma schema engine failed while deploying migrations."
        : code === "schema_parsing_failure"
          ? "Prisma schema parsing/validation failed while deploying migrations."
          : code === "database_unreachable"
            ? "Database is unreachable; Prisma migrate deploy cannot run."
            : code === "missing_env"
              ? "DATABASE_URL is missing; Prisma migrate deploy cannot run."
              : code === "invalid_database_url"
                ? "DATABASE_URL is invalid; Prisma migrate deploy cannot run."
                : "Prisma migrate deploy failed.",
    }

    if (code === "database_unreachable" || code === "missing_env") {
      emitDiagnostic("migrate-deploy", diagnostic, { detail: stringifyError(lastError).slice(0, 4000) })
      emitMigrationStatus("skipped", {
        reason: code,
        message: diagnostic.message,
      })
      console.warn("[vercel-build] migrate-deploy skipped because the database is temporarily unreachable; continuing to next build.")
      return false
    }

    if (code === "schema_parsing_failure" || code === "invalid_database_url" || code === "engine_binary_failure") {
      emitMigrationStatus("failed", {
        reason: code,
        message: diagnostic.message,
      })
    }
    handlePreflightFailure("migrate-deploy", diagnostic, lastError)
  }

  return false
}

function runSchemaCompatibilityCheck(canReachDatabase) {
  if (!canReachDatabase) {
    console.warn("[vercel-build] schema compatibility check skipped because migration preflight did not confirm database availability.")
    return
  }

  try {
    console.log("[vercel-build] checking runtime database schema compatibility...")
    execSync("node scripts/schema-health-check.js", { stdio: "inherit", env })
  } catch (error) {
    handlePreflightFailure("schema-health", {
      ok: false,
      code: classifyPrismaFailure(stringifyError(error)),
      message: "Runtime database schema compatibility check failed.",
    }, error)
  }
}

;(async () => {
  await runPrismaGenerateWithRetry()
  const migrationsDeployed = await runMigrationDeployment()
  runSchemaCompatibilityCheck(migrationsDeployed)

  console.log(`[vercel-build] final prismaMigrationStatus=${prismaMigrationStatus}`)
  execSync("npx next build --webpack", { stdio: "inherit", env })
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
