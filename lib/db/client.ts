import { Prisma, PrismaClient } from "@prisma/client"
import { env } from "@/lib/env"

/**
 * Prisma client lifecycle for serverless (Vercel + Neon + PgBouncer).
 *
 * KNOWN PRODUCTION FAILURE: `Error { kind: Closed }` ("server has closed the
 * connection"). Root cause:
 *   - Lambda freezes between requests; underlying TCP socket is killed by
 *     PgBouncer / Neon's idle-timeout but Prisma's client still holds a
 *     reference to the dead connection.
 *   - On lambda thaw, the next query is dispatched on a stale socket and
 *     fails immediately with kind=Closed.
 *
 * GUARANTEES PROVIDED HERE:
 *   1. Singleton across hot lambda invocations (no per-request new client).
 *   2. Transparent retry middleware: any query failing with a stale-connection
 *      shape is retried once after a small delay. Prisma's internal pool will
 *      open a fresh socket on the retry.
 *   3. Pool sizing left to DATABASE_URL (?connection_limit=1 for serverless +
 *      PgBouncer transaction mode is the documented Neon contract).
 */

const globalForPrisma = global as unknown as { prisma?: PrismaClient }
let prismaSingleton: PrismaClient | undefined

function assertPostgresDatabaseUrl() {
  // During build phase, DATABASE_URL may not be available (handled by vercel-build.js separately)
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return
  }

  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required to initialize Prisma client")
  }

  if (!/^postgres(?:ql)?:\/\//i.test(env.databaseUrl)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string")
  }
}

const STALE_CONNECTION_MARKERS = [
  "kind: closed",
  "connection closed",
  "server has closed",
  "connection terminated",
  "terminating connection",
  "etimedout",
  "econnreset",
  "eai_again",
]

function looksLikeStaleConnection(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? ""
  ).toLowerCase()
  if (!message) return false
  return STALE_CONNECTION_MARKERS.some((marker) => message.includes(marker))
}

function isPrismaTransientError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError
  ) {
    return looksLikeStaleConnection(error)
  }
  return looksLikeStaleConnection(error)
}

function attachRetryMiddleware(client: PrismaClient) {
  client.$use(async (params, next) => {
    try {
      return await next(params)
    } catch (error) {
      if (!isPrismaTransientError(error)) throw error

      // Best-effort observability so operators can correlate stale-connection
      // recoveries with traffic spikes / lambda thaw events.
      console.warn("[prisma] stale-connection retry", {
        model: params.model,
        action: params.action,
        error: error instanceof Error ? error.message : String(error),
      })

      // Tiny backoff so we don't immediately re-hammer a flapping pooler.
      await new Promise((resolve) => setTimeout(resolve, 75))

      // Single retry. Two consecutive stale-connection errors indicates a
      // real outage; we surface the second error to the caller.
      return await next(params)
    }
  })

  return client
}

function createPrismaClient(): PrismaClient {
  assertPostgresDatabaseUrl()

  const client = new PrismaClient({
    log: ["warn", "error"],
  })

  return attachRetryMiddleware(client)
}

export function getPrisma(): PrismaClient {
  if (prismaSingleton) {
    return prismaSingleton
  }

  if (env.nodeEnv !== "production" && globalForPrisma.prisma) {
    prismaSingleton = globalForPrisma.prisma
    return prismaSingleton
  }

  const prismaClient = createPrismaClient()
  prismaSingleton = prismaClient

  if (env.nodeEnv !== "production") {
    globalForPrisma.prisma = prismaClient
  }

  return prismaClient
}

const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrisma()
    const value = Reflect.get(client, property, receiver)

    if (typeof value === "function") {
      return value.bind(client)
    }

    return value
  },
})

export { prisma }
export default prisma
