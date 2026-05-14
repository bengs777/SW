import { PrismaClient } from '@prisma/client'
import { env } from '@/lib/env'

const globalForPrisma = global as unknown as { prisma?: PrismaClient }
let prismaSingleton: PrismaClient | undefined

function assertPostgresDatabaseUrl() {
  // During build phase, DATABASE_URL may not be available (handled by vercel-build.js separately)
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return
  }

  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to initialize Prisma client')
  }

  if (!/^postgres(?:ql)?:\/\//i.test(env.databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection string')
  }
}

function createPrismaClient(): PrismaClient {
  assertPostgresDatabaseUrl()

  return new PrismaClient({
    log: ['warn', 'error'],
  })
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
