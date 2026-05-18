const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")
const { loadEnvConfig } = require("@next/env")

loadEnvConfig(process.cwd())

const env = { ...process.env }
const isWindows = process.platform === "win32"
const maxAttempts = 3

const prismaClientPackageJson = require.resolve("@prisma/client/package.json")
const prismaClientDir = path.resolve(
  path.dirname(prismaClientPackageJson),
  "..",
  "..",
  ".prisma",
  "client",
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hasExistingPrismaClient() {
  return fs.existsSync(path.join(prismaClientDir, "index.d.ts"))
}

function stringifyError(error) {
  return [error?.message, error?.stdout, error?.stderr, error?.output]
    .map((value) => {
      if (Buffer.isBuffer(value)) {
        return value.toString("utf8")
      }

      if (Array.isArray(value)) {
        return value
          .map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item || "")))
          .join("\n")
      }

      return String(value || "")
    })
    .join("\n")
}

function isWindowsPrismaEngineLock(errorText) {
  return /eperm|operation not permitted/i.test(errorText) && /query_engine|rename/i.test(errorText)
}

async function main() {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = execSync("npx prisma generate", { env, encoding: "utf8" })

      if (output) {
        process.stdout.write(output)
      }

      return
    } catch (error) {
      const errorText = stringifyError(error)

      if (!isWindows || !isWindowsPrismaEngineLock(errorText)) {
        throw error
      }

      if (attempt === maxAttempts) {
        if (hasExistingPrismaClient()) {
          console.warn("[prisma-generate] Windows kept the Prisma engine locked; using the existing generated client.")
          return
        }

        throw error
      }

      const retryDelayMs = 1500 * attempt
      console.warn(
        `[prisma-generate] Prisma engine is locked on attempt ${attempt}/${maxAttempts}; retrying in ${retryDelayMs}ms...`,
      )
      await sleep(retryDelayMs)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
