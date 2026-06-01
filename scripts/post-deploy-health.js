const http = require("node:http")
const https = require("node:https")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd())

const HEALTH_TIMEOUT_MS = Number(process.env.SWIFT_POST_DEPLOY_HEALTH_TIMEOUT_MS || 15_000)
const HEALTH_RETRIES = Math.max(1, Number(process.env.SWIFT_POST_DEPLOY_HEALTH_RETRIES || 1))
const HEALTH_RETRY_DELAY_MS = Math.max(0, Number(process.env.SWIFT_POST_DEPLOY_HEALTH_RETRY_DELAY_MS || 5_000))
const FOLLOW_REDIRECTS = process.env.SWIFT_POST_DEPLOY_FOLLOW_REDIRECTS === "true"
const MAX_REDIRECTS = Math.max(0, Number(process.env.SWIFT_POST_DEPLOY_MAX_REDIRECTS || 5))
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

function sleep(ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJson(body) {
  try {
    return { json: JSON.parse(body), parseError: null }
  } catch (error) {
    return {
      json: null,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
}

function fetchJson(url, redirects = []) {
  const client = url.startsWith("https://") ? https : http
  return new Promise((resolve, reject) => {
    const request = client.get(url, { timeout: HEALTH_TIMEOUT_MS, headers: { accept: "application/json" } }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => {
        const statusCode = response.statusCode || 0
        const location = response.headers.location || ""
        const redirect = statusCode >= 300 && statusCode < 400 && location
        if (redirect && FOLLOW_REDIRECTS) {
          if (redirects.length >= MAX_REDIRECTS) {
            reject(new Error(`Health endpoint exceeded ${MAX_REDIRECTS} redirects. Last location: ${location}`))
            return
          }

          const nextUrl = new URL(location, url).toString()
          fetchJson(nextUrl, [...redirects, { from: url, to: nextUrl, statusCode }]).then(resolve, reject)
          return
        }

        const parsed = parseJson(body)
        resolve({
          url,
          statusCode,
          headers: response.headers,
          json: parsed.json,
          parseError: parsed.parseError,
          bodySnippet: body.slice(0, 500),
          redirects,
        })
      })
    })
    request.on("timeout", () => {
      request.destroy(new Error(`Health request timed out after ${HEALTH_TIMEOUT_MS}ms`))
    })
    request.on("error", reject)
  })
}

function checkStatus(name, value, failures) {
  if (value === "unhealthy" || value === "disabled" || value === "missing") {
    failures.push(`${name}:${value}`)
    return
  }

  if (!allowDegraded && value === "degraded") {
    failures.push(`${name}:degraded`)
  }
}

async function runHealthAttempt(url, attempt) {
  const response = await fetchJson(url)
  const { statusCode, json } = response
  const failures = []
  const redirectLocation = response.headers?.location || ""

  if (statusCode < 200 || statusCode >= 300) failures.push(`http:${statusCode}`)
  if (statusCode >= 300 && statusCode < 400) {
    failures.push(`redirect:${redirectLocation || "missing-location"}`)
  }
  if (response.parseError) {
    failures.push(`invalid-json:${response.parseError}`)
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    failures.push("body:not-object")
  }

  if (json && typeof json === "object") {
    if (json.status === "unhealthy") failures.push("status:unhealthy")
    if (!allowDegraded && json.status === "degraded") failures.push("status:degraded")

    checkStatus("database", json.database, failures)
    checkStatus("auth", json.auth, failures)
    checkStatus("deployment", json.deployment, failures)
    checkStatus("queue", json.queue, failures)
    checkStatus("environment", json.checks?.environment?.status, failures)
    checkStatus("providers", json.checks?.providers?.status, failures)

    const worker = json.worker
    if (worker === "unhealthy" || worker === "disabled" || worker === "missing") failures.push(`worker:${worker}`)
    if (!allowDegraded && worker === "degraded") failures.push("worker:degraded")
  }

  const summary = {
    url: response.url || url,
    initialUrl: url,
    httpStatus: statusCode,
    status: json?.status || null,
    database: json?.database || null,
    auth: json?.auth || null,
    deployment: json?.deployment || null,
    queue: json?.queue || null,
    worker: json?.worker || null,
    provider: json?.checks?.providers?.status || null,
    environment: json?.checks?.environment?.status || null,
    checkedAt: json?.checkedAt || null,
    requestId: json?.requestId || null,
    allowDegraded,
    attempt,
    retries: HEALTH_RETRIES,
    redirects: response.redirects || [],
    redirectLocation: redirectLocation || null,
    bodySnippet: response.parseError ? response.bodySnippet : undefined,
  }

  console.log(JSON.stringify(summary, null, 2))

  return failures
}

async function main() {
  const url = resolveTargetUrl()
  let failures = []

  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt += 1) {
    failures = await runHealthAttempt(url, attempt)
    if (failures.length === 0) {
      console.log("POST_DEPLOY_HEALTH_OK")
      return
    }

    if (attempt < HEALTH_RETRIES) {
      console.error(`POST_DEPLOY_HEALTH_RETRY: ${failures.join(", ")}`)
      await sleep(HEALTH_RETRY_DELAY_MS)
    }
  }

  if (failures.length > 0) {
    console.error(`POST_DEPLOY_HEALTH_FAILED: ${failures.join(", ")}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error("POST_DEPLOY_HEALTH_FAILED:", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
