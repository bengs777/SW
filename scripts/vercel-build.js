const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const env = { ...process.env }
env.NODE_ENV = "production"
env.DATABASE_URL = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || "file:./dev.db"

const isWindows = process.platform === "win32"
const MAX_PRISMA_GENERATE_ATTEMPTS = 3

const prismaClientPackageJson = require.resolve("@prisma/client/package.json")
const prismaClientDir = path.resolve(path.dirname(prismaClientPackageJson), "..", "..", ".prisma", "client")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const hasExistingPrismaClient = () => fs.existsSync(path.join(prismaClientDir, "index.d.ts"))

async function runPrismaGenerateWithRetry() {
  let lastError = null

  for (let attempt = 1; attempt <= MAX_PRISMA_GENERATE_ATTEMPTS; attempt += 1) {
    try {
      const output = execSync("npx prisma generate", { env, encoding: "utf8" })

      if (output) {
        process.stdout.write(output)
      }

      return
    } catch (error) {
      lastError = error
      const errorText = [
        error?.message,
        error?.stdout,
        error?.stderr,
        error?.output,
      ]
        .map((value) => {
          if (Buffer.isBuffer(value)) {
            return value.toString("utf8")
          }

          if (Array.isArray(value)) {
            return value
              .map((item) => {
                if (Buffer.isBuffer(item)) {
                  return item.toString("utf8")
                }

                return String(item || "")
              })
              .join("\n")
          }

          return String(value || "")
        })
        .join("\n")

      const isEpermLock =
        /eperm|operation not permitted/i.test(errorText) &&
        /query_engine|rename/i.test(errorText)

      if (!isWindows || !isEpermLock) {
        throw error
      }

      if (attempt === MAX_PRISMA_GENERATE_ATTEMPTS) {
        if (hasExistingPrismaClient()) {
          console.warn("[vercel-build] prisma generate could not replace the Windows engine after multiple attempts; continuing with the existing Prisma client.")
          return
        }

        throw error
      }

      const retryDelayMs = 1500 * attempt
      console.warn(`[vercel-build] prisma generate failed on attempt ${attempt}/${MAX_PRISMA_GENERATE_ATTEMPTS} due to Windows file lock, retrying in ${retryDelayMs}ms...`)
      await sleep(retryDelayMs)
    }
  }

  if (lastError) {
    throw lastError
  }
}

;(async () => {
  await runPrismaGenerateWithRetry()

  execSync("npx next build --webpack", { stdio: "inherit", env })
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
