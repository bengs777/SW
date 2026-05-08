const { execSync, spawn } = require("child_process")
const path = require("path")

const LOCAL_PRISMA_DATABASE_URL = "file:./dev.db"
const LOCAL_RUNTIME_DATABASE_URL = "file:./prisma/dev.db"

const env = { ...process.env }
env.NODE_ENV = "development"
env.DATABASE_URL = process.env.DATABASE_URL || LOCAL_PRISMA_DATABASE_URL
env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || LOCAL_RUNTIME_DATABASE_URL

const nextCli = path.normalize(require.resolve("next/dist/bin/next"))

function runPrismaDbPush() {
  try {
    const output = execSync("npx prisma db push --skip-generate", {
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
