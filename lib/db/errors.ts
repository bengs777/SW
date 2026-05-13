import { Prisma } from "@prisma/client"

const REQUIRED_TABLES = [
  "User",
  "Workspace",
  "WorkspaceMember",
  "Project",
  "UsageLog",
  "BillingTransaction",
  "Subscription",
]

export function isMissingRequiredTableError(error: unknown) {
  const message =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? `${error.message} ${error.meta ? JSON.stringify(error.meta) : ""}`
      : error instanceof Error
        ? error.message
        : String(error)

  if (!/no such table/i.test(message)) {
    return false
  }

  return REQUIRED_TABLES.some((table) =>
    new RegExp(`main\\.${table}\\b`, "i").test(message)
  )
}

export function shouldSoftFailMissingTable() {
  return process.env.NODE_ENV !== "production"
}

function isTransientDatabaseWriteError(error: unknown) {
  const message =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? `${error.message} ${error.meta ? JSON.stringify(error.meta) : ""}`
      : error instanceof Error
        ? error.message
        : String(error)

  return /SQLITE_BUSY|database is locked|deadlock detected|could not serialize access|canceling statement due to statement timeout|connection terminated|ECONNRESET|ETIMEDOUT/i.test(message)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withDatabaseWriteRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 6)
  const baseDelayMs = Math.max(25, options.baseDelayMs ?? 120)
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientDatabaseWriteError(error) || attempt === attempts - 1) {
        throw error
      }

      await sleep(baseDelayMs * (attempt + 1))
    }
  }

  throw lastError
}
