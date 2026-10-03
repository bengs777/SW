import { db } from '@/lib/db/client'
import { apiKeys, workspaces } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
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

    const result = await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      workspaceId,
      name,
      key: keyHash,
      expiresAt,
    }).returning()

    return {
      ...result[0],
      key,
    }
  }

  static async getApiKeys(workspaceId: string) {
    return db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      lastUsed: apiKeys.lastUsed,
      expiresAt: apiKeys.expiresAt,
    }).from(apiKeys)
      .where(eq(apiKeys.workspaceId, workspaceId))
      .orderBy(desc(apiKeys.createdAt))
  }

  static async getApiKeyByKey(key: string) {
    const keyHash = this.hashKey(key)
    const hashedKey = await db.select().from(apiKeys)
      .where(eq(apiKeys.key, keyHash))
      .limit(1)

    if (hashedKey.length > 0) {
      const workspace = await db.select().from(workspaces)
        .where(eq(workspaces.id, hashedKey[0].workspaceId))
        .limit(1)
      return { ...hashedKey[0], workspace: workspace[0] }
    }

    const plainKey = await db.select().from(apiKeys)
      .where(eq(apiKeys.key, key))
      .limit(1)

    if (plainKey.length > 0) {
      const workspace = await db.select().from(workspaces)
        .where(eq(workspaces.id, plainKey[0].workspaceId))
        .limit(1)
      return { ...plainKey[0], workspace: workspace[0] }
    }

    return null
  }

  static async updateLastUsed(apiKeyId: string) {
    return db.update(apiKeys)
      .set({ lastUsed: new Date() })
      .where(eq(apiKeys.id, apiKeyId))
      .returning()
  }

  static async deleteApiKey(apiKeyId: string) {
    return db.delete(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .returning()
  }

  static async rotateApiKey(apiKeyId: string) {
    const oldKey = await db.select().from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1)

    if (oldKey.length === 0) {
      throw new Error('API key not found')
    }

    await db.delete(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))

    const newKey = this.generateKey()
    const newKeyHash = this.hashKey(newKey)
    const apiKey = await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      workspaceId: oldKey[0].workspaceId,
      name: oldKey[0].name,
      key: newKeyHash,
    }).returning()

    return {
      ...apiKey[0],
      key: newKey,
    }
  }
}
