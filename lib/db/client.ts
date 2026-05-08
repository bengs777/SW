import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { PrismaClient } from '@prisma/client'
import { createClient } from '@libsql/client'
import { env } from '@/lib/env'

const globalForPrisma = global as unknown as { prisma?: PrismaClient }
let prismaSingleton: PrismaClient | undefined

function resolveDatabaseUrl() {
  return env.tursoDatabaseUrl || env.databaseUrl || (env.nodeEnv === 'production' ? '' : 'file:./dev.db')
}

function createPrismaClient(): PrismaClient {
  const databaseUrl = resolveDatabaseUrl()

  if (!databaseUrl) {
    throw new Error('TURSO_DATABASE_URL or DATABASE_URL is required to initialize Prisma client')
  }

  const prismaAdapter = new PrismaLibSQL(
    createClient({
      url: databaseUrl,
      authToken: env.tursoAuthToken || undefined,
    })
  )

  return new PrismaClient({
    adapter: prismaAdapter,
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
