const { execSync, spawn } = require("child_process")
const fs = require("fs")
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

const env = { ...loadDotEnv(path.join(process.cwd(), ".env")), ...process.env }
env.NODE_ENV = "development"
env.DATABASE_URL = env.DATABASE_URL || ""

if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
  console.error("[dev] DATABASE_URL must be a PostgreSQL connection string. Use a Neon development branch or local Postgres database.")
  process.exit(1)
}

const nextCli = path.normalize(require.resolve("next/dist/bin/next"))

function runPrismaDbPush() {
  try {
    const output = execSync("node scripts/db-push.js local", {
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

    console.error("[dev] Prisma schema sync failed before starting Next dev.")
    console.error(message)
    process.exit(1)
  }
}

function startNextDev() {
  const child = spawn(process.execPath, [nextCli, "dev"], {
    env,
    stdio: "inherit",
    shell: false,
  })

  const shutdown = (signal) => {
    if (!child.killed) {
      child.kill(signal)
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  child.on("exit", (code) => {
    process.exit(code ?? 0)
  })
}

runPrismaDbPush()
startNextDev()
