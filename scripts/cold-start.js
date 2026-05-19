const { execFileSync, spawn } = require("node:child_process")
const path = require("node:path")

const port = Number(process.env.COLD_START_PORT || 4500 + Math.floor(Math.random() * 1000))
const timeoutMs = Number(process.env.COLD_START_TIMEOUT_MS || 45_000)
const url = `http://127.0.0.1:${port}/api/health?coldStart=true`
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next")
let childProcess = null
let cleanupStarted = false

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(child) {
  const startedAt = Date.now()
  let lastError = ""

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`next start exited before health became available. exitCode=${child.exitCode} signal=${child.signalCode}`)
    }

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      })
      const data = await response.json().catch(() => null)
      if (
        data &&
        typeof data.status === "string" &&
        typeof data.database === "string" &&
        typeof data.worker === "string" &&
        typeof data.queue === "string"
      ) {
        return {
          coldStart: "passed",
          status: data.status,
          database: data.database,
          worker: data.worker,
          queue: data.queue,
          durationMs: Date.now() - startedAt,
          httpStatus: response.status,
        }
      }
      lastError = `Invalid health payload with HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await sleep(500)
  }

  throw new Error(`Cold start did not serve health within ${timeoutMs}ms. Last error: ${lastError}`)
}

function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    process.kill(pid, "SIGTERM")
  }
}

function getListeningPortOwners() {
  if (process.platform !== "win32") return []
  try {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
    const localPort = new RegExp(`(?:^|\\s)(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\[::1\\]):${port}\\s`)
    return Array.from(new Set(
      output
        .split(/\r?\n/)
        .filter((line) => line.includes("LISTENING") && localPort.test(line))
        .map((line) => Number(line.trim().split(/\s+/).at(-1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    ))
  } catch {
    return []
  }
}

function killListeningPortOwners() {
  for (const pid of getListeningPortOwners()) {
    try {
      killProcessTree(pid)
    } catch {
      // best effort for orphan cleanup
    }
  }
}

function cleanupSync() {
  if (cleanupStarted) return
  cleanupStarted = true
  try {
    if (childProcess && childProcess.exitCode === null && !childProcess.signalCode) {
      try {
        killProcessTree(childProcess.pid)
      } catch {
        childProcess.kill("SIGKILL")
      }
    }
  } catch {
    // best effort during process teardown
  } finally {
    killListeningPortOwners()
  }
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      killListeningPortOwners()
      resolve()
      return
    }

    const timer = setTimeout(() => {
      try {
        killProcessTree(child.pid)
      } catch {
        // The process may already be gone.
      } finally {
        killListeningPortOwners()
      }
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timer)
      killListeningPortOwners()
      resolve()
    })
    try {
      child.kill("SIGTERM")
    } catch {
      try {
        killProcessTree(child.pid)
      } catch {
        // The process may already be gone.
      } finally {
        clearTimeout(timer)
        killListeningPortOwners()
        resolve()
      }
    }
  })
}

function countPortOwners() {
  return getListeningPortOwners().length
}

process.on("exit", cleanupSync)
process.on("SIGINT", () => {
  cleanupSync()
  process.exit(130)
})
process.on("SIGTERM", () => {
  cleanupSync()
  process.exit(143)
})

async function main() {
  if (countPortOwners() > 0) {
    throw new Error(`Cold start port ${port} is already in use.`)
  }

  const child = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        SWIFT_ENABLE_AI_WARMUP: "false",
        SWIFT_ENABLE_GENERATION_WORKER: "false",
      },
      stdio: "pipe",
      shell: false,
    }
  )
  childProcess = child

  let output = ""
  child.stdout.on("data", (chunk) => {
    output += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    output += String(chunk)
  })

  try {
    const result = await waitForHealth(child)
    await stopServer(child)
    if (countPortOwners() > 0) {
      killListeningPortOwners()
      await sleep(500)
    }
    const orphanProcesses = countPortOwners()
    console.log(JSON.stringify({
      coldStart: "passed",
      rootCause: null,
      orphanProcesses,
    }))
  } catch (error) {
    console.error(output.slice(-4000))
    throw error
  } finally {
    process.off("exit", cleanupSync)
    await stopServer(child)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
