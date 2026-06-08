const fs = require("node:fs")
const path = require("node:path")
const { execSync } = require("node:child_process")

const root = process.cwd()
const EXPECTED_SANDBOX_PUBLIC_URL = "https://sandbox.ai-swift.biz.id"
const EXPECTED_OPENROUTER_MODEL = "glm-5.1"
const EXPECTED_AGENTROUTER_BASE_URL = "https://agentrouter.org/v1"
const LEGACY_MODEL_ENV_KEYS = [
  "OPENROUTER_FREE_MODEL",
  "OPENROUTER_MODEL_ID",
  "SWIFT_FALLBACK_MODEL_1",
  "AGENTROUTER_FALLBACK_MODEL",
  "AGENTROUTER_FALLBACK_MODELS",
  "OPENROUTER_FALLBACK_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
]

const files = {
  local: ".env",
  vercel: ".env.production",
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
  const baseUrl = value(env, "AGENTROUTER_BASE_URL") || value(env, "OPENROUTER_BASE_URL")
  const model = value(env, "AGENTROUTER_MODEL") || value(env, "OPENROUTER_MODEL")
  assert(checks, baseUrl === EXPECTED_AGENTROUTER_BASE_URL, `${label}: AI gateway base URL points to AgentRouter API`)
  assert(checks, value(env, "SWIFT_AI_PROVIDER_NAME") === "agentrouter", `${label}: SWIFT_AI_PROVIDER_NAME uses AgentRouter`)
  assert(checks, model === EXPECTED_OPENROUTER_MODEL, `${label}: AI model uses the configured Swift default model`)
  assert(checks, !hasAny(env, LEGACY_MODEL_ENV_KEYS), `${label}: legacy/fallback model variables are not configured`)
  assert(checks, value(env, "SWIFT_AI_MODEL_CHAIN") === "agentrouter:glm-5.1", `${label}: Swift model chain uses AgentRouter glm-5.1 only`)
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
  assert(checks, value(parsed.vercel, "SANDBOX_SERVICE_URL") === EXPECTED_SANDBOX_PUBLIC_URL, ".env.production: sandbox service URL uses verified custom domain")
  assert(checks, value(parsed.vercel, "SANDBOX_PUBLIC_BASE_URL") === EXPECTED_SANDBOX_PUBLIC_URL, ".env.production: sandbox public base URL uses verified custom domain")
  checkCommonProvider(checks, parsed.vercel, ".env.production")

  for (const file of [".env." + "rail" + "way.production", ".env." + "rail" + "way.worker.production"]) {
    assert(checks, !fs.existsSync(path.join(root, file)), `${file}: removed for production`)
  }

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
