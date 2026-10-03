const { spawnSync } = require("child_process")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd())

const env = { ...process.env }
env.NODE_ENV = "production"

const isStrictPreflight =
  process.env.SWIFT_STRICT_MIGRATIONS === "true" ||
  process.env.VERCEL === "1" ||
  process.env.CI === "true"
const MAX_MIGRATE_ATTEMPTS = 3
let migrationStatus = "skipped"

function classifyMigrationFailure(errorText) {
  const text = String(errorText || "")
  if (/missing_env|TURSO_DATABASE_URL is required/i.test(text)) return "missing_env"
  if (/invalid_database_url|invalid.*url/i.test(text)) return "invalid_database_url"
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|timed out|timeout|database_unreachable/i.test(text)) {
    return "database_unreachable"
  }
  if (/schema_failure|no such table|no such column|syntax error|already exists|constraint/i.test(text)) {
    return "schema_failure"
  }
  return "migration_failed"
}

function emitMigrationStatus(status, detail) {
  migrationStatus = status
  console.log(`[vercel-build] migration_status=${status}${detail ? ` ${detail}` : ""}`)
}

function runNodeScript(scriptPath, attempts = 1) {
  let lastOutput = ""
  let lastStatus = 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      shell: false,
    })
    lastOutput = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n")
    lastStatus = result.status ?? 1
    if (lastStatus === 0) return { ok: true, output: lastOutput }
    if (classifyMigrationFailure(lastOutput) !== "database_unreachable") break
  }
  return { ok: false, output: lastOutput, status: lastStatus }
}

function runMigrationDeployment() {
  if (!process.env.TURSO_DATABASE_URL) {
    if (isStrictPreflight()) {
      emitMigrationStatus("failed", "missing_env")
      throw new Error("[vercel-build] TURSO_DATABASE_URL is required to deploy migrations in strict mode")
    }
    emitMigrationStatus("skipped", "missing_env")
    return
  }

  const result = runNodeScript("scripts/drizzle-migrate.js", MAX_MIGRATE_ATTEMPTS)
  if (result.ok) {
    const skipped = /status=skipped/.test(result.output)
    emitMigrationStatus(skipped ? "skipped" : "applied", skipped ? "local_fallback" : "ok")
    return
  }

  const failureKind = classifyMigrationFailure(result.output)
  if (failureKind === "database_unreachable") {
    if (isStrictPreflight()) {
      emitMigrationStatus("failed", failureKind)
      throw new Error(`[vercel-build] migrations cannot deploy (${failureKind}); aborting build in strict mode`)
    }
    emitMigrationStatus("skipped", failureKind)
    console.log("[vercel-build] database unreachable during migrate deploy, continuing to next build")
    return
  }

  emitMigrationStatus("failed", failureKind)
  if (isStrictPreflight()) {
    throw new Error(`[vercel-build] migration deployment failed (${failureKind}); aborting build in strict mode`)
  }
  console.log(`[vercel-build] migration deployment failed (${failureKind}), continuing to next build`)
}

function runSchemaHealthCheck() {
  const result = runNodeScript("scripts/schema-health-check.js", 1)
  if (result.ok) {
    console.log("[vercel-build] schema health check passed")
    return
  }
  if (isStrictPreflight()) {
    throw new Error("[vercel-build] schema health check failed; aborting build in strict mode")
  }
  console.log("[vercel-build] schema compatibility check skipped in local fallback mode")
}

function runNextBuild() {
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx"
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx next build --webpack"]
    : ["next", "build", "--webpack"]
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    shell: false,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    const status = result.status ?? result.signal ?? "unknown"
    throw new Error(`[vercel-build] next build failed with status ${status}`)
  }
}

console.log("[vercel-build] starting migration deployment...")
try {
  runMigrationDeployment()
  runSchemaHealthCheck()
} catch (error) {
  if (isStrictPreflight()) throw error
  console.log("[vercel-build] preflight skipped in local fallback mode:", error?.message || error)
}

console.log(`[vercel-build] migrationStatus=${migrationStatus}`)
console.log("[vercel-build] starting next build...")
runNextBuild()
console.log("[vercel-build] build completed successfully")
