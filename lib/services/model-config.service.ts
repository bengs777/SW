import { prisma } from "@/lib/db/client"
import { getRuntimeModelOptions } from "@/lib/ai/runtime-models"
import { LEGACY_SWIFT_2_MODEL_KEY, SWIFT_BUILDER_MODEL_KEY } from "@/lib/ai/model-tiers"

export class ModelConfigService {
  static async ensureDefaults() {
    const runtimeOptions = getRuntimeModelOptions()
    const defaultModelKeys = runtimeOptions.map((model) => model.key)

    await Promise.all(
      runtimeOptions.map((model) =>
        prisma.modelConfig.upsert({
          where: { key: model.key },
          update: {
            provider: model.provider,
            modelName: model.modelName,
            price: model.price,
            isActive: model.isActive,
          },
          create: {
            key: model.key,
            provider: model.provider,
            modelName: model.modelName,
            price: model.price,
            isActive: model.isActive,
          },
        })
      )
    )

    await prisma.modelConfig.updateMany({
      where: {
        key: {
          notIn: defaultModelKeys,
        },
      },
      data: {
        isActive: false,
      },
    })
  }

  static async getActiveModels() {
    await this.ensureDefaults()
    const runtimeOptions = getRuntimeModelOptions()
    const rankByKey = new Map(runtimeOptions.map((model, index) => [model.key, model.rank ?? index + 1]))

    const models = await prisma.modelConfig.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    })

    return models.sort((left, right) => {
      const leftRank = rankByKey.get(left.key) ?? 999
      const rightRank = rankByKey.get(right.key) ?? 999
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.createdAt.getTime() - right.createdAt.getTime()
    })
  }

  static async getActiveModelByKey(key: string) {
    await this.ensureDefaults()
    const normalizedKey = key === LEGACY_SWIFT_2_MODEL_KEY ? SWIFT_BUILDER_MODEL_KEY : key

    return prisma.modelConfig.findFirst({
      where: {
        key: normalizedKey,
        isActive: true,
      },
    })
  }
}
