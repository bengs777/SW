import { PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'
import { log } from '@/lib/logging'
import { warnIfSlow } from '@/lib/observability/performance-monitor'
import { recordPrismaDuration } from '@/lib/observability/runtime-metrics'

const globalForPrisma = global as unknown as { prisma?: PrismaClient }
let prismaSingleton: PrismaClient | undefined

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
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  })

  client.$on('query', (event) => {
    recordPrismaDuration(event.duration, { target: event.target })
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

export function getPrisma(): PrismaClient {
  if (prismaSingleton) {
    return prismaSingleton
  }

  if (env.nodeEnv !== 'production' && globalForPrisma.prisma) {
    prismaSingleton = globalForPrisma.prisma
    return prismaSingleton
  }

  const prismaClient = createPrismaClient()
  prismaSingleton = prismaClient

  if (env.nodeEnv !== 'production') {
    globalForPrisma.prisma = prismaClient
  }

  return prismaClient
}

const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getPrisma()
    const value = Reflect.get(client, property, receiver)

    if (typeof value === 'function') {
      return value.bind(client)
    }

    return value
  },
})

export { prisma }
export default prisma
