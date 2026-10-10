const { execSync, spawn } = require("child_process")
const fs = require("fs")
const http = require("http")
const net = require("net")
const path = require("path")

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {}

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=")
        if (separatorIndex < 1) return null
        const key = line.slice(0, separatorIndex).trim()
        const rawValue = line.slice(separatorIndex + 1).trim()
        const value = rawValue.replace(/^["']|["']$/g, "")
        return [key, value]
      })
      .filter(Boolean)
  )
}

const env = { ...loadDotEnv(path.join(process.cwd(), ".env")), ...loadDotEnv(path.join(process.cwd(), ".env.local")), ...process.env }
env.NODE_ENV = "development"

const databaseUrl = (env.TURSO_DATABASE_URL || "").trim()

if (databaseUrl && !/^(libsql|https?):\/\//i.test(databaseUrl)) {
  console.error("[dev] TURSO_DATABASE_URL must be a libsql:// or https:// connection string.")
  process.exit(1)
}

const nextCli = path.normalize(require.resolve("next/dist/bin/next"))

function runMigrations() {
  if (!databaseUrl) {
    console.warn("[dev] TURSO_DATABASE_URL not set; skipping schema migration (local fallback).")
    return
  }

  try {
    const output = execSync("node scripts/drizzle-migrate.js", {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    if (output) {
      process.stdout.write(output)
    }
  } catch (error) {
    const message = [error?.message, error?.stdout, error?.stderr]
      .map((value) => {
        if (Buffer.isBuffer(value)) {
          return value.toString("utf8")
        }

        return String(value || "")
      })
      .join("\n")

    console.error("[dev] Drizzle schema migration failed before starting Next dev.")
    console.error(message)
    process.exit(1)
  }
}

const workerDisabled = ["false", "0", "off"].includes(String(env.SWIFT_DEV_WORKER || "").toLowerCase())
const workerHealthPort = Number(env.SWIFT_WORKER_HEALTH_PORT || 4000)
let generationWorker = null
let shuttingDown = false

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "0.0.0.0")
  })
}

function probeGenerationWorker(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          resolve(body?.worker?.workerType === "generation" && body?.worker?.healthy === true)
        } catch {
          resolve(false)
        }
      })
    })
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
  })
}

async function startGenerationWorker() {
  if (workerDisabled) {
    console.log("[dev] SWIFT_DEV_WORKER disabled; generation worker not started.")
    return null
  }

  if (await probeGenerationWorker(workerHealthPort)) {
    console.log(`[dev] Generation worker already healthy on :${workerHealthPort}; reusing it.`)
    return null
  }

  const workerEnv = { ...env }
  if (await isPortAvailable(workerHealthPort)) {
    workerEnv.SWIFT_WORKER_HEALTH_PORT = String(workerHealthPort)
  } else {
    console.warn(`[dev] Port ${workerHealthPort} busy; generation worker starts without its health endpoint.`)
  }

  const child = spawn(process.execPath, ["scripts/run-ts-script.js", "workers/index.ts", "--type=generation"], {
    env: workerEnv,
    stdio: "inherit",
    shell: false,
  })

  console.log("[dev] Generation worker started (set SWIFT_DEV_WORKER=false to disable).")

  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    console.warn(
      `[dev] Generation worker stopped (code=${code}, signal=${signal}). Generation jobs will stay queued. Restart with: npm run worker:generation`
    )
  })

  return child
}

function stopGenerationWorker(signal) {
  if (generationWorker && generationWorker.exitCode === null && !generationWorker.killed) {
    generationWorker.kill(signal)
  }
}

let sandboxRuntime = null
const sandboxPort = Number(env.SANDBOX_RUNTIME_PORT || 8080)

async function startSandboxRuntime() {
  const sandboxDisabled = ["false", "0", "off"].includes(String(env.SWIFT_SANDBOX_RUNTIME || "").toLowerCase())
  if (sandboxDisabled) {
    console.log("[dev] SWIFT_SANDBOX_RUNTIME disabled; sandbox runtime not started.")
    return null
  }

  const available = await isPortAvailable(sandboxPort)
  if (!available) {
    console.log(`[dev] Sandbox runtime port :${sandboxPort} already in use; reusing existing instance.`)
    return null
  }

  const runtimeScript = path.join(process.cwd(), "services", "sandbox-runtime", "server.mjs")
  if (!fs.existsSync(runtimeScript)) {
    console.warn(`[dev] Sandbox runtime script not found at ${runtimeScript}`)
    return null
  }

  const child = spawn(process.execPath, [runtimeScript], {
    env: { ...env, PORT: String(sandboxPort) },
    stdio: "inherit",
    shell: false,
  })

  console.log(`[dev] Sandbox runtime started on :${sandboxPort}`)

  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    console.warn(
      `[dev] Sandbox runtime stopped (code=${code}, signal=${signal}). Terminal and runtime preview may disconnect.`
    )
  })

  return child
}

function stopSandboxRuntime(signal) {
  if (sandboxRuntime && sandboxRuntime.exitCode === null && !sandboxRuntime.killed) {
    sandboxRuntime.kill(signal)
  }
}

function startNextDev() {
  const child = spawn(process.execPath, [nextCli, "dev"], {
    env,
    stdio: "inherit",
    shell: false,
  })

  const shutdown = (signal) => {
    shuttingDown = true
    if (!child.killed) {
      child.kill(signal)
    }
    stopGenerationWorker(signal)
    stopSandboxRuntime(signal)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  child.on("exit", (code) => {
    shuttingDown = true
    stopGenerationWorker("SIGTERM")
    stopSandboxRuntime("SIGTERM")
    process.exit(code ?? 0)
  })
}

async function main() {
  runMigrations()
  generationWorker = await startGenerationWorker()
  sandboxRuntime = await startSandboxRuntime()
  startNextDev()
}

main()
