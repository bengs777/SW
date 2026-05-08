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
