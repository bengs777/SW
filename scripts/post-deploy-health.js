const http = require("node:http")
const https = require("node:https")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd())

const HEALTH_TIMEOUT_MS = Number(process.env.SWIFT_POST_DEPLOY_HEALTH_TIMEOUT_MS || 15_000)
const allowDegraded = process.env.SWIFT_POST_DEPLOY_ALLOW_DEGRADED === "true"

function normalizeBaseUrl(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withProtocol.replace(/\/+$/, "")
}

function resolveTargetUrl() {
  const explicit = normalizeBaseUrl(process.argv[2])
  const fromEnv = normalizeBaseUrl(
    process.env.SWIFT_POST_DEPLOY_URL ||
      process.env.DEPLOYMENT_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      process.env.NEXTAUTH_URL ||
      process.env.VERCEL_URL
  )
  const baseUrl = explicit || fromEnv
  if (!baseUrl) {
    throw new Error("Missing deployment URL. Pass one argument or set SWIFT_POST_DEPLOY_URL/DEPLOYMENT_URL/NEXT_PUBLIC_APP_URL.")
  }
  return `${baseUrl}/api/health?refreshProvider=true`
}

function fetchJson(url) {
  const client = url.startsWith("https://") ? https : http
  return new Promise((resolve, reject) => {
    const request = client.get(url, { timeout: HEALTH_TIMEOUT_MS, headers: { accept: "application/json" } }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => {
        try {
          const json = JSON.parse(body)
          resolve({ statusCode: response.statusCode || 0, json })
        } catch {
          reject(new Error(`Health endpoint did not return JSON. HTTP ${response.statusCode}: ${body.slice(0, 500)}`))
        }
      })
    })
    request.on("timeout", () => {
      request.destroy(new Error(`Health request timed out after ${HEALTH_TIMEOUT_MS}ms`))
    })
    request.on("error", reject)
  })
}

function checkStatus(name, value, failures) {
  if (value === "unhealthy" || value === "disabled") {
    failures.push(`${name}:${value}`)
  }
}

async function main() {
  const url = resolveTargetUrl()
  const { statusCode, json } = await fetchJson(url)
  const failures = []

  if (statusCode >= 500) failures.push(`http:${statusCode}`)
  if (json.status === "unhealthy") failures.push("status:unhealthy")
  if (!allowDegraded && json.status === "degraded") failures.push("status:degraded")

  checkStatus("database", json.database, failures)
  checkStatus("auth", json.auth, failures)
  checkStatus("deployment", json.deployment, failures)
  checkStatus("queue", json.queue, failures)
  checkStatus("environment", json.checks?.environment?.status, failures)

  const worker = json.worker
  if (worker === "unhealthy" || worker === "disabled") failures.push(`worker:${worker}`)

  const summary = {
    url,
    httpStatus: statusCode,
    status: json.status,
    database: json.database,
    auth: json.auth,
    deployment: json.deployment,
    queue: json.queue,
    worker: json.worker,
    provider: json.checks?.providers?.status || null,
    environment: json.checks?.environment?.status || null,
    checkedAt: json.checkedAt || null,
    requestId: json.requestId || null,
    allowDegraded,
  }

  console.log(JSON.stringify(summary, null, 2))

  if (failures.length > 0) {
    console.error(`POST_DEPLOY_HEALTH_FAILED: ${failures.join(", ")}`)
    process.exitCode = 1
    return
  }

  console.log("POST_DEPLOY_HEALTH_OK")
}

main().catch((error) => {
  console.error("POST_DEPLOY_HEALTH_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
