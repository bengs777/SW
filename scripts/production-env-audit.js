const fs = require("node:fs")
const path = require("node:path")
const { execSync } = require("node:child_process")

const root = process.cwd()
const EXPECTED_SANDBOX_URL = "https://sanbox.ai-swift.biz.id"
const EXPECTED_WORKER_HEALTH_URL = "https://ingenious-appreciation-production.up.railway.app/health"
const EXPECTED_MODEL_CHAIN = "openrouter:deepseek/deepseek-v4-pro"

const files = {
  local: ".env",
  vercel: ".env.production",
  railwayWorker: ".env.railway.worker.production",
  railwaySandbox: ".env.railway.production",
}

function parseEnvFile(file) {
  const fullPath = path.join(root, file)
  if (!fs.existsSync(fullPath)) {
    return { file, exists: false, values: new Map(), duplicates: [] }
  }

  const values = new Map()
  const duplicates = []
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/)

  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/)
    if (!match) continue
    const key = match[1]
    const value = match[2].trim()
    if (values.has(key)) duplicates.push(key)
    values.set(key, value)
  }

  return { file, exists: true, values, duplicates }
}

function assert(checks, condition, message) {
  checks.push({ ok: Boolean(condition), message })
}

function value(env, key) {
  return env.values.get(key) || ""
}

function hasAny(env, keys) {
  return keys.some((key) => Boolean(value(env, key)))
}

function checkCommonProvider(checks, env, label) {
  assert(checks, value(env, "OPENROUTER_BASE_URL") === "https://openrouter.ai/api/v1", `${label}: OPENROUTER_BASE_URL points to OpenRouter API`)
  assert(checks, value(env, "SWIFT_AI_MODEL_CHAIN") === EXPECTED_MODEL_CHAIN, `${label}: SWIFT_AI_MODEL_CHAIN uses the stabilized DeepSeek route`)
  assert(checks, value(env, "SWIFT_AI_FREE_MODE") === "false", `${label}: SWIFT_AI_FREE_MODE is false`)
  assert(checks, !hasAny(env, ["SWIFT_FALLBACK_MODEL_1", "SWIFT_FALLBACK_MODEL_2", "SWIFT_FALLBACK_MODEL_3", "OPENROUTER_FREE_MODEL"]), `${label}: degraded free fallback variables are not configured`)
}

function checkEnv() {
  const checks = []
  const parsed = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, parseEnvFile(file)]))

  for (const env of Object.values(parsed)) {
    assert(checks, env.exists, `${env.file}: file exists`)
    assert(checks, env.duplicates.length === 0, `${env.file}: no duplicate env keys`)
  }

  assert(checks, value(parsed.local, "NODE_ENV") === "development", ".env: local development mode")
  assert(checks, value(parsed.local, "NEXTAUTH_URL") === "http://localhost:3000", ".env: local NEXTAUTH_URL")

  assert(checks, value(parsed.vercel, "NODE_ENV") === "production", ".env.production: production mode")
  assert(checks, value(parsed.vercel, "NEXTAUTH_URL") === "https://www.ai-swift.biz.id", ".env.production: production NEXTAUTH_URL")
  assert(checks, value(parsed.vercel, "NEXT_PUBLIC_APP_URL") === "https://www.ai-swift.biz.id", ".env.production: production public app URL")
  assert(checks, value(parsed.vercel, "SWIFT_GENERATION_EXECUTION_MODE") === "queue", ".env.production: generation runs in queue mode")
  assert(checks, value(parsed.vercel, "SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK") === "true", ".env.production: serverless generation fallback is disabled")
  assert(checks, value(parsed.vercel, "SWIFT_WORKER_HEALTH_URL") === EXPECTED_WORKER_HEALTH_URL, ".env.production: worker health URL points to Railway worker")
  assert(checks, value(parsed.vercel, "SANDBOX_SERVICE_URL") === EXPECTED_SANDBOX_URL, ".env.production: sandbox service URL uses verified custom domain")
  checkCommonProvider(checks, parsed.vercel, ".env.production")

  assert(checks, value(parsed.railwayWorker, "NODE_ENV") === "production", ".env.railway.worker.production: production mode")
  assert(checks, value(parsed.railwayWorker, "PORT") === "4000", ".env.railway.worker.production: worker health port")
  assert(checks, value(parsed.railwayWorker, "SWIFT_WORKER_TYPE") === "generation", ".env.railway.worker.production: worker type generation")
  assert(checks, value(parsed.railwayWorker, "SWIFT_GENERATION_EXECUTION_MODE") === "queue", ".env.railway.worker.production: queue execution mode")
  assert(checks, value(parsed.railwayWorker, "SWIFT_ENABLE_GENERATION_WORKER") === "true", ".env.railway.worker.production: generation worker enabled")
  assert(checks, value(parsed.railwayWorker, "SANDBOX_SERVICE_URL") === EXPECTED_SANDBOX_URL, ".env.railway.worker.production: sandbox service URL uses verified custom domain")
  checkCommonProvider(checks, parsed.railwayWorker, ".env.railway.worker.production")

  assert(checks, value(parsed.railwaySandbox, "NODE_ENV") === "production", ".env.railway.production: production mode")
  assert(checks, value(parsed.railwaySandbox, "PORT") === "8080", ".env.railway.production: sandbox service port")
  assert(checks, value(parsed.railwaySandbox, "SANDBOX_PUBLIC_BASE_URL") === EXPECTED_SANDBOX_URL, ".env.railway.production: sandbox public URL uses verified custom domain")
  assert(checks, value(parsed.railwaySandbox, "SWIFT_SANDBOX_ROOT") === "/data/swift-sandbox", ".env.railway.production: sandbox root uses Railway volume")

  const gitignore = fs.existsSync(path.join(root, ".gitignore")) ? fs.readFileSync(path.join(root, ".gitignore"), "utf8") : ""
  assert(checks, /\.env\*/.test(gitignore), ".gitignore: blocks all .env* files")

  let trackedEnvFiles = ""
  try {
    trackedEnvFiles = execSync("git ls-files -- .env*", { cwd: root, encoding: "utf8" }).trim()
  } catch {
    trackedEnvFiles = "__git_check_failed__"
  }
  assert(checks, trackedEnvFiles === "", "git: no .env* files are tracked")

  return checks
}

function main() {
  const checks = checkEnv()
  let failed = 0

  for (const check of checks) {
    if (check.ok) {
      console.log(`PASS ${check.message}`)
    } else {
      failed += 1
      console.error(`FAIL ${check.message}`)
    }
  }

  if (failed > 0) {
    throw new Error(`production env audit failed: ${failed} issue(s)`)
  }
}

main()
