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
  if (/schema engine error|query_engine|schema-engine|libquery_engine|engine binary|binary target/i.test(text)) {
    return "engine_binary_failure"
  }
  if (/schema parsing|error validating|prisma schema|schema\.prisma|P10\d{2}|P20\d{2}/i.test(text)) {
    return "schema_parsing_failure"
  }
  if (/invalid.*database_url|must start with the protocol|connection string|postgres/i.test(text)) {
    return "invalid_database_url"
  }
  if (/environment variable.*DATABASE_URL|DATABASE_URL.*not found|missing.*DATABASE_URL/i.test(text)) {
    return "missing_env"
  }
  return "unknown_prisma_failure"
}

function diagnoseDatabaseUrl() {
  const value = process.env.DATABASE_URL || ""
  if (!value.trim()) {
    return {
      ok: false,
      code: "missing_env",
      message: "DATABASE_URL is missing; Prisma migrate status cannot run.",
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

function runDeploymentPreflight() {
  const database = diagnoseDatabaseUrl()
  if (!database.ok) {
    handlePreflightFailure("migrate-status", database)
    return false
  }

  try {
    console.log("[vercel-build] checking migration status...")
    const output = execSync("npx prisma migrate status", { env, encoding: "utf8" })
    if (output) process.stdout.write(output)
    return true
  } catch (error) {
    const code = classifyPrismaFailure(stringifyError(error))
    handlePreflightFailure("migrate-status", {
      ok: false,
      code,
      message: code === "engine_binary_failure"
        ? "Prisma schema engine failed while checking migration status."
        : code === "schema_parsing_failure"
          ? "Prisma schema parsing/validation failed while checking migration status."
          : "Prisma migrate status failed.",
    }, error)
    return false
  }
}

function runSchemaCompatibilityCheck(canReachDatabase) {
  if (!canReachDatabase && !isStrictPreflight) {
    console.warn("[vercel-build] schema compatibility check skipped in local fallback mode because migration preflight did not confirm database availability.")
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
  const migrationPreflightOk = runDeploymentPreflight()
  runSchemaCompatibilityCheck(migrationPreflightOk)

  execSync("npx next build --webpack", { stdio: "inherit", env })
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
