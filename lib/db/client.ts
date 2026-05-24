import { PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'
import { log } from '@/lib/logging'
import { warnIfSlow } from '@/lib/observability/performance-monitor'
import { recordPrismaDuration } from '@/lib/observability/runtime-metrics'
import {
  recordDbConnectionFailure,
  recordDbPoolUsage,
  recordDbQueryTime,
  recordDbRetry,
} from '@/lib/db/metrics'
import {
  isDatabaseCircuitOpen,
  markDatabaseCircuitFailure,
  markDatabaseCircuitSuccess,
} from '@/lib/db/circuit-breaker'

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient
  prismaProxyCache?: WeakMap<object, object>
  prismaRuntimeStats?: {
    createdClients: number
    disconnectedClients: number
    activeClients: number
    exitHooksInstalled: boolean
  }
}
let prismaSingleton: PrismaClient | undefined
const prismaRuntimeStats = globalForPrisma.prismaRuntimeStats || (globalForPrisma.prismaRuntimeStats = {
  createdClients: 0,
  disconnectedClients: 0,
  activeClients: 0,
  exitHooksInstalled: false,
})
const DB_QUERY_TIMEOUT_MS = Math.max(1_000, Number(process.env.DB_QUERY_TIMEOUT_MS || 10_000))
const DB_MAX_RETRIES = Math.max(0, Math.min(5, Number(process.env.DB_MAX_RETRIES || 2)))
const DB_RETRY_BASE_DELAY_MS = Math.max(50, Number(process.env.DB_RETRY_BASE_DELAY_MS || 250))
const DB_CONNECTION_LIMIT = Math.max(1, Number(process.env.DB_CONNECTION_LIMIT || 8))
const DB_POOL_TIMEOUT_SECONDS = Math.max(1, Number(process.env.DB_POOL_TIMEOUT_SECONDS || 10))

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withDatabaseUrlPoolDefaults(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl)
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", String(DB_CONNECTION_LIMIT))
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", String(DB_POOL_TIMEOUT_SECONDS))
    }
    return url.toString()
  } catch {
    return databaseUrl
  }
}

export type DatabaseRuntimeDiagnostic = {
  ok: boolean
  code: "ok" | "missing_env" | "invalid_database_url" | "prisma_client_missing"
  message: string
}

export function getDatabaseRuntimeDiagnostic(): DatabaseRuntimeDiagnostic {
  if (!env.databaseUrl) {
    return {
      ok: false,
      code: "missing_env",
      message: "DATABASE_URL is required to initialize Prisma client",
    }
  }

  if (!/^postgres(?:ql)?:\/\//i.test(env.databaseUrl)) {
    return {
      ok: false,
      code: "invalid_database_url",
      message: "DATABASE_URL must be a PostgreSQL connection string",
    }
  }

  if (typeof PrismaClient !== 'function') {
    return {
      ok: false,
      code: "prisma_client_missing",
      message: "Prisma client is not generated. Run npm run db:generate.",
    }
  }

  return {
    ok: true,
    code: "ok",
    message: "Database runtime configuration is valid.",
  }
}

function assertPostgresDatabaseUrl() {
  const diagnostic = getDatabaseRuntimeDiagnostic()
  if (!diagnostic.ok && diagnostic.code !== "prisma_client_missing") {
    log('error', 'database_runtime_config_invalid', {
      code: diagnostic.code,
      message: diagnostic.message,
      nodeEnv: env.nodeEnv,
    })
    throw new Error(diagnostic.message)
  }
}

function assertPrismaClientGenerated() {
  const diagnostic = getDatabaseRuntimeDiagnostic()
  if (diagnostic.code === "prisma_client_missing") {
    log('error', 'database_runtime_config_invalid', {
      code: diagnostic.code,
      message: diagnostic.message,
      nodeEnv: env.nodeEnv,
    })
    throw new Error(diagnostic.message)
  }
}

function createPrismaClient(): PrismaClient {
  assertPostgresDatabaseUrl()
  assertPrismaClientGenerated()

  const client = new PrismaClient({
    datasources: {
      db: {
        url: withDatabaseUrlPoolDefaults(env.databaseUrl),
      },
    },
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  })

  client.$on('query', (event) => {
    recordPrismaDuration(event.duration, { target: event.target })
    recordDbQueryTime(event.duration)
    warnIfSlow('prisma', event.duration, { target: event.target })
  })

  client.$on('warn', (event) => {
    log('warn', 'prisma_warning', {
      message: event.message,
      target: event.target,
    })
  })

  client.$on('error', (event) => {
    log('error', 'prisma_error', {
      message: event.message,
      target: event.target,
    })
  })

  return client
}

function isConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  return /can't reach database|connection|connect|pool|timeout|timed out|closed|ECONNRESET|ETIMEDOUT|P1001|P1002|P2024/i.test(message)
}

async function reconnectPrisma() {
  const current = prismaSingleton
  if (!current) return
  await current.$disconnect().catch(() => null)
  prismaRuntimeStats.disconnectedClients += 1
  prismaRuntimeStats.activeClients = Math.max(0, prismaRuntimeStats.activeClients - 1)
  prismaSingleton = undefined
  if (env.nodeEnv !== 'production') {
    globalForPrisma.prisma = undefined
  }
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
  if (isDatabaseCircuitOpen()) {
    throw new Error("Database circuit breaker is cooling down after repeated connection failures.")
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= DB_MAX_RETRIES; attempt += 1) {
    const startedAt = Date.now()
    try {
      const result = await withQueryTimeout(operation, fn())
      const durationMs = Date.now() - startedAt
      recordDbQueryTime(durationMs)
      markDatabaseCircuitSuccess()
      return result
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)

      if (isConnectionError(error)) {
        recordDbConnectionFailure()
        markDatabaseCircuitFailure(message)
        await reconnectPrisma()
      }

      if (attempt >= DB_MAX_RETRIES || !isConnectionError(error)) {
        throw error
      }

      recordDbRetry()
      const delayMs = Math.round(DB_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * DB_RETRY_BASE_DELAY_MS)
      log('warn', 'database_retry_scheduled', {
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

function proxiedObject<T extends object>(target: T, path: string): T {
  const cache = globalForPrisma.prismaProxyCache || (globalForPrisma.prismaProxyCache = new WeakMap<object, object>())
  const cached = cache.get(target)
  if (cached) return cached as T

  const proxy = new Proxy(target, {
    get(innerTarget, property, receiver) {
      const value = Reflect.get(innerTarget, property, receiver)
      if (typeof value === 'function') {
        return (...args: unknown[]) =>
          resilientDatabaseCall(`${path}.${String(property)}`, () => value.apply(innerTarget, args))
      }
      if (value && typeof value === 'object') {
        return proxiedObject(value, `${path}.${String(property)}`)
      }
      return value
    },
  })
  cache.set(target, proxy)
  return proxy
}

export function getPrisma(): PrismaClient {
  if (prismaSingleton) {
    return prismaSingleton
  }

  if (env.nodeEnv !== 'production' && globalForPrisma.prisma) {
    prismaSingleton = globalForPrisma.prisma
    return prismaSingleton
  }

  const prismaClient = createPrismaClient()
  prismaRuntimeStats.createdClients += 1
  prismaRuntimeStats.activeClients += 1
  prismaSingleton = prismaClient

  if (env.nodeEnv !== 'production') {
    globalForPrisma.prisma = prismaClient
  }

  return prismaClient
}

export async function disconnectPrisma() {
  await reconnectPrisma()
}

export function getPrismaRuntimeStats() {
  return {
    prisma_client_count: prismaRuntimeStats.createdClients,
    activePrismaClients: prismaRuntimeStats.activeClients,
    disconnectedPrismaClients: prismaRuntimeStats.disconnectedClients,
  }
}

function installPrismaExitHooks() {
  if (prismaRuntimeStats.exitHooksInstalled) return
  prismaRuntimeStats.exitHooksInstalled = true
  const cleanup = () => {
    const current = prismaSingleton
    if (!current) return
    prismaSingleton = undefined
    if (env.nodeEnv !== 'production') {
      globalForPrisma.prisma = undefined
    }
    prismaRuntimeStats.disconnectedClients += 1
    prismaRuntimeStats.activeClients = Math.max(0, prismaRuntimeStats.activeClients - 1)
    void current.$disconnect().catch(() => null)
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

installPrismaExitHooks()

const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrisma()
    const value = Reflect.get(client, property, receiver)

    if (typeof value === 'function') {
      return (...args: unknown[]) =>
        resilientDatabaseCall(`prisma.${String(property)}`, () => value.apply(client, args))
    }

    if (value && typeof value === 'object') {
      return proxiedObject(value, `prisma.${String(property)}`)
    }

    return value
  },
})

export { prisma }
export default prisma

export async function getDatabasePoolUsage() {
  try {
    const result = await resilientDatabaseCall("prisma.poolUsage", () =>
      getPrisma().$queryRaw<Array<{ active_connections: bigint | number; max_connections: bigint | number }>>`
        SELECT
          count(*)::int AS active_connections,
          current_setting('max_connections')::int AS max_connections
        FROM pg_stat_activity
        WHERE datname = current_database()
      `
    )
    const row = result[0]
    const active = Number(row?.active_connections || 0)
    const max = Number(row?.max_connections || 0)
    const usagePct = max > 0 ? Math.round((active / max) * 1000) / 10 : 0
    recordDbPoolUsage(usagePct)
    return { activeConnections: active, maxConnections: max, usagePct }
  } catch (error) {
    return {
      activeConnections: 0,
      maxConnections: 0,
      usagePct: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
