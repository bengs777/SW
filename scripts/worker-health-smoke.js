const http = require("node:http")
const https = require("node:https")

try {
  const { loadEnvConfig } = require("@next/env")
  loadEnvConfig(process.cwd())
} catch {
  // If @next/env is unavailable, continue with the process environment.
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "")
}

function resolveWorkerHealthUrl() {
  if (process.env.SWIFT_WORKER_HEALTH_URL || process.env.WORKER_HEALTH_URL) {
    return process.env.SWIFT_WORKER_HEALTH_URL || process.env.WORKER_HEALTH_URL
  }

  const sandboxBaseUrl = trimTrailingSlash(
    process.env.SANDBOX_PUBLIC_BASE_URL || process.env.SANDBOX_SERVICE_URL
  )
  if (sandboxBaseUrl) {
    return `${sandboxBaseUrl}/worker/health`
  }

  return "http://127.0.0.1:4000/health"
}

const url = resolveWorkerHealthUrl()

function requestJson(targetUrl) {
  const parsed = new URL(targetUrl)
  const client = parsed.protocol === "https:" ? https : http

  return new Promise((resolve, reject) => {
    const request = client.request(parsed, { method: "GET", timeout: 5000 }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode,
            body: JSON.parse(body),
          })
        } catch (error) {
          reject(new Error(`Invalid JSON health response: ${error.message}`))
        }
      })
    })

    request.on("timeout", () => {
      request.destroy(new Error("Worker health request timed out"))
    })
    request.on("error", reject)
    request.end()
  })
}

async function main() {
  const response = await requestJson(url)
  if (response.statusCode !== 200 || response.body.status !== "healthy" || response.body.mode !== "queue") {
    console.error(JSON.stringify(response.body, null, 2))
    throw new Error(`Worker health failed with HTTP ${response.statusCode}`)
  }

  console.log(JSON.stringify({
    worker: response.body.status,
    mode: response.body.mode,
    endpoint: url,
  }))
}

main().catch((error) => {
  console.error(error)
  console.error(
    `Worker health endpoint checked: ${url}. Set SWIFT_WORKER_HEALTH_URL to the public worker proxy or start the local worker health server.`
  )
  process.exit(1)
})
