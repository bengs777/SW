import { prisma } from '@/lib/db/client'
import crypto from 'crypto'

const API_KEY_PREFIX = 'swift'

export class ApiKeyService {
  static generateKey(): string {
    return `${API_KEY_PREFIX}_${crypto.randomBytes(32).toString('hex')}`
  }

  static hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex')
  }

  static async createApiKey(
    workspaceId: string,
    name: string,
    expiresAt?: Date
  ) {
    const key = this.generateKey()
    const keyHash = this.hashKey(key)

    const apiKey = await prisma.apiKey.create({
      data: {
        workspaceId,
        name,
        key: keyHash,
        expiresAt,
      },
    })

    return {
      ...apiKey,
      key,
    }
  }

  static async getApiKeys(workspaceId: string) {
    return prisma.apiKey.findMany({
      where: { workspaceId },
      select: {
        id: true,
        name: true,
        key: false, // Don't return the full key
        createdAt: true,
        lastUsed: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  static async getApiKeyByKey(key: string) {
    const keyHash = this.hashKey(key)
    const hashedKey = await prisma.apiKey.findUnique({
      where: { key: keyHash },
      include: {
        workspace: true,
      },
    })

    if (hashedKey) {
      return hashedKey
    }

    return prisma.apiKey.findUnique({
      where: { key },
      include: {
        workspace: true,
      },
    })
  }

  static async updateLastUsed(apiKeyId: string) {
    return prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { lastUsed: new Date() },
    })
  }

  static async deleteApiKey(apiKeyId: string) {
    return prisma.apiKey.delete({
      where: { id: apiKeyId },
    })
  }

  static async rotateApiKey(apiKeyId: string) {
    const oldKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
    })

    if (!oldKey) {
      throw new Error('API key not found')
    }

    // Delete old key and create new one
    await prisma.apiKey.delete({
      where: { id: apiKeyId },
    })

    const newKey = this.generateKey()
    const newKeyHash = this.hashKey(newKey)
    const apiKey = await prisma.apiKey.create({
      data: {
        workspaceId: oldKey.workspaceId,
        name: oldKey.name,
        key: newKeyHash,
      },
    })

    return {
      ...apiKey,
      key: newKey,
    }
  }
}
