import { PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'
import { log } from '@/lib/logging'
import { warnIfSlow } from '@/lib/observability/performance-monitor'
import { recordPrismaDuration } from '@/lib/observability/runtime-metrics'

const globalForPrisma = global as unknown as { prisma?: PrismaClient }
let prismaSingleton: PrismaClient | undefined

function assertPostgresDatabaseUrl() {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to initialize Prisma client')
  }

  if (!/^postgres(?:ql)?:\/\//i.test(env.databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection string')
  }
}

function createPrismaClient(): PrismaClient {
  assertPostgresDatabaseUrl()

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
