import { drizzle } from "drizzle-orm/libsql"
import { createClient } from "@libsql/client"
import { env } from "@/lib/env"
import { log } from "@/lib/logging"
import * as schema from "./schema"

const globalForDb = global as unknown as {
  db?: ReturnType<typeof createDb>["db"]
  dbSchema?: unknown
  libsqlClient?: ReturnType<typeof createClient>
  dbRuntimeStats?: {
    createdClients: number
    disconnectedClients: number
    activeClients: number
    exitHooksInstalled: boolean
  }
}

const dbRuntimeStats = globalForDb.dbRuntimeStats || (globalForDb.dbRuntimeStats = {
  createdClients: 0,
  disconnectedClients: 0,
  activeClients: 0,
  exitHooksInstalled: false,
})

const DB_QUERY_TIMEOUT_MS = Math.max(1_000, Number(process.env.DB_QUERY_TIMEOUT_MS || 10_000))
const DB_MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.DB_MAX_RETRIES || 2)))
const DB_RETRY_BASE_DELAY_MS = Math.max(50, Number(process.env.DB_RETRY_BASE_DELAY_MS || 250))

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type DatabaseRuntimeDiagnostic = {
  ok: boolean
  code: "ok" | "missing_env" | "invalid_database_url" | "db_client_missing"
  message: string
}

export function getDatabaseRuntimeDiagnostic(): DatabaseRuntimeDiagnostic {
  if (!env.tursoDatabaseUrl) {
    return {
      ok: false,
      code: "missing_env",
      message: "TURSO_DATABASE_URL is required to initialize database client",
    }
  }

  if (!env.tursoAuthToken) {
    return {
      ok: false,
      code: "missing_env",
      message: "TURSO_AUTH_TOKEN is required to initialize database client",
    }
  }

  if (!/^libsql:\/\//i.test(env.tursoDatabaseUrl)) {
    return {
      ok: false,
      code: "invalid_database_url",
      message: "TURSO_DATABASE_URL must be a libSQL connection string",
    }
  }

  return {
    ok: true,
    code: "ok",
    message: "Database runtime configuration is valid.",
  }
}

function createDb() {
  const diagnostic = getDatabaseRuntimeDiagnostic()
  if (!diagnostic.ok) {
    log("error", "database_runtime_config_invalid", {
      code: diagnostic.code,
      message: diagnostic.message,
      nodeEnv: env.nodeEnv,
    })
    throw new Error(diagnostic.message)
  }

  const libsqlClient = createClient({
    url: env.tursoDatabaseUrl,
    authToken: env.tursoAuthToken,
  })

  const db = drizzle(libsqlClient, { schema })

  dbRuntimeStats.createdClients += 1
  dbRuntimeStats.activeClients += 1

  return { db, libsqlClient }
}

function isConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  return /connection|connect|timeout|timed out|closed|ECONNRESET|ETIMEDOUT|SQLITE_BUSY|no such table/i.test(message)
}

async function withQueryTimeout<T>(operation: string, promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Database query timed out after ${DB_QUERY_TIMEOUT_MS}ms: ${operation}`)), DB_QUERY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function resilientDatabaseCall<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= DB_MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now()
    try {
      const result = await withQueryTimeout(operation, fn())
      const durationMs = Date.now() - startedAt
      if (durationMs > 1000) {
        log("warn", "database_slow_query", { operation, durationMs })
      }
      return result
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)

      if (attempt >= DB_MAX_RETRIES || !isConnectionError(error)) {
        throw error
      }

      const delayMs = Math.round(DB_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * DB_RETRY_BASE_DELAY_MS)
      log("warn", "database_retry_scheduled", {
        operation,
        attempt: attempt + 1,
        maxRetries: DB_MAX_RETRIES,
        delayMs,
        error: message,
      })
      await sleep(delayMs)
    }
  }

  throw lastError
}

function getDb() {
  if (globalForDb.db && globalForDb.dbSchema === schema) {
    return globalForDb.db
  }

  const { db, libsqlClient } = createDb()
  globalForDb.db = db
  globalForDb.libsqlClient = libsqlClient
  globalForDb.dbSchema = schema

  return db
}

function installDbExitHooks() {
  if (dbRuntimeStats.exitHooksInstalled) return
  if (typeof process === "undefined" || !process.once) return
  dbRuntimeStats.exitHooksInstalled = true

  const cleanup = () => {
    dbRuntimeStats.disconnectedClients += 1
    dbRuntimeStats.activeClients = Math.max(0, dbRuntimeStats.activeClients - 1)
    globalForDb.db = undefined
  }

  process.once("beforeExit", cleanup)
  process.once("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    cleanup()
    process.exit(143)
  })
}

installDbExitHooks()

function isThenable(value: unknown): value is { then: (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

function createResilientChain<T extends object>(target: T, operation: string): T {
  return new Proxy(target, {
    get(targetObject, property) {
      const resilientThen = (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) =>
        resilientDatabaseCall(operation, () =>
          new Promise((resolve, reject) => {
            const then = Reflect.get(targetObject, "then", targetObject)
            if (typeof then === "function") {
              then.call(targetObject, resolve, reject)
            } else {
              reject(new Error(`Thenable query for ${operation} lost its then() method`))
            }
          })
        ).then(onFulfilled, onRejected)

      if (property === "then") {
        return resilientThen
      }

      if (property === "catch") {
        return (onRejected?: (reason: unknown) => unknown) => resilientThen(undefined, onRejected)
      }

      if (property === "finally") {
        return (onFinally?: () => unknown) =>
          resilientThen(
            (value) => {
              onFinally?.()
              return value
            },
            (reason) => {
              onFinally?.()
              throw reason
            }
          )
      }

      const value = Reflect.get(targetObject, property, targetObject)
      if (typeof value === "function") {
        return (...args: unknown[]) => wrapDbCall(operation, () => Reflect.apply(value, targetObject, args))
      }

      return value
    },
  }) as T
}

function wrapDbCall(operation: string, invoke: () => unknown): unknown {
  const result = invoke()

  if (result instanceof Promise) {
    let started = true
    return resilientDatabaseCall(operation, () => {
      if (started) {
        started = false
        return result
      }
      return invoke() as Promise<unknown>
    })
  }

  if (isThenable(result)) {
    return createResilientChain(result, operation)
  }

  return result
}

const db = new Proxy({} as ReturnType<typeof createDb>["db"], {
  get(_target, property, receiver) {
    const database = getDb()
    const value = Reflect.get(database, property, receiver)

    if (typeof value === "function") {
      const operation = `db.${String(property)}`
      return (...args: unknown[]) => wrapDbCall(operation, () => value.apply(database, args))
    }

    return value
  },
})

// Ensure db is properly initialized
getDb()

export { db, schema }
export default db

export async function disconnectDb() {
  dbRuntimeStats.disconnectedClients += 1
  dbRuntimeStats.activeClients = Math.max(0, dbRuntimeStats.activeClients - 1)
  if (globalForDb.libsqlClient) {
    await globalForDb.libsqlClient.close()
    globalForDb.libsqlClient = undefined
  }
  globalForDb.db = undefined
}

export function getDbRuntimeStats() {
  return {
    db_client_count: dbRuntimeStats.createdClients,
    activeDbClients: dbRuntimeStats.activeClients,
    disconnectedDbClients: dbRuntimeStats.disconnectedClients,
  }
}

export function getDatabasePoolUsage() {
  const stats = getDbRuntimeStats()
  const maxConnections = Number(process.env.DB_MAX_CONNECTIONS || 10)
  const usagePct = Number(((stats.activeDbClients / Math.max(1, maxConnections)) * 100).toFixed(2))
  return {
    activeConnections: stats.activeDbClients,
    maxConnections,
    poolUsage: stats.activeDbClients / Math.max(1, maxConnections),
    usagePct,
  }
}
