import { db } from "@/lib/db/client"
import { modelConfigs } from "@/lib/db/schema"
import { eq, and, asc, notInArray } from "drizzle-orm"
import { getRuntimeModelOptions } from "@/lib/ai/runtime-models"
import {
  LEGACY_SWIFT_2_MODEL_KEY,
  SWIFT_BUILDER_MODEL_KEY,
  SWIFT_FAST_MODEL_KEY,
  SWIFT_PREMIUM_REPAIR_MODEL_KEY,
} from "@/lib/ai/model-tiers"

function normalizeSwiftModelKey(key: string) {
  if (
    key === LEGACY_SWIFT_2_MODEL_KEY ||
    key === SWIFT_FAST_MODEL_KEY ||
    key === SWIFT_PREMIUM_REPAIR_MODEL_KEY
  ) {
    return SWIFT_BUILDER_MODEL_KEY
  }

  return key
}

export class ModelConfigService {
  static async ensureDefaults() {
    const runtimeOptions = getRuntimeModelOptions()
    const defaultModelKeys = runtimeOptions.map((model) => model.key)

    await Promise.all(
      runtimeOptions.map(async (model) => {
        const existing = await db.select().from(modelConfigs).where(eq(modelConfigs.key, model.key)).limit(1)

        if (existing.length > 0) {
          await db.update(modelConfigs)
            .set({
              provider: model.provider,
              modelName: model.modelName,
              price: model.price,
              isActive: model.isActive,
            })
            .where(eq(modelConfigs.key, model.key))
        } else {
          await db.insert(modelConfigs).values({
          id: crypto.randomUUID(),
            key: model.key,
            provider: model.provider,
            modelName: model.modelName,
            price: model.price,
            isActive: model.isActive,
          })
        }
      })
    )

    await db.update(modelConfigs)
      .set({ isActive: false })
      .where(notInArray(modelConfigs.key, defaultModelKeys))
  }

  static async getActiveModels() {
    await this.ensureDefaults()
    const runtimeOptions = getRuntimeModelOptions()
    const rankByKey = new Map(runtimeOptions.map((model, index) => [model.key, model.rank ?? index + 1]))

    const models = await db.select().from(modelConfigs).where(eq(modelConfigs.isActive, true)).orderBy(asc(modelConfigs.createdAt))

    return models.sort((left, right) => {
      const leftRank = rankByKey.get(left.key) ?? 999
      const rightRank = rankByKey.get(right.key) ?? 999
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.createdAt.getTime() - right.createdAt.getTime()
    })
  }

  static async getActiveModelByKey(key: string) {
    await this.ensureDefaults()
    const normalizedKey = normalizeSwiftModelKey(key)

    const result = await db.select().from(modelConfigs)
      .where(and(
        eq(modelConfigs.key, normalizedKey),
        eq(modelConfigs.isActive, true)
      ))
      .limit(1)

    return result[0] || null
  }
}
