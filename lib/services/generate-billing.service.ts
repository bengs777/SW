import { db } from "@/lib/db/client"
import { users, billingTransactions, modelConfigs, usageLogs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { SWIFT_PUBLIC_PRICE_IDR } from "@/lib/ai/model-tiers"

interface BalanceCheckResult {
  hasBalance: boolean
  currentBalance: number
  shortfall: number
}

interface DeductResult {
  success: boolean
  error?: string
  newBalance?: number
}

interface CostBreakdown {
  provider: string
  model: string
  costPerRequest: number
  totalCost: number
  currency: string
}

export class GenerateBillingService {
  static async checkBalance(userId: string, requiredAmount: number): Promise<BalanceCheckResult> {
    try {
      const result = await db.select({ balance: users.balance }).from(users)
        .where(eq(users.id, userId))
        .limit(1)

      const currentBalance = result[0]?.balance || 0
      const hasBalance = currentBalance >= requiredAmount

      return {
        hasBalance,
        currentBalance,
        shortfall: hasBalance ? 0 : requiredAmount - currentBalance,
      }
    } catch (error) {
      console.error("[GenerateBillingService] Error checking balance:", error)
      return {
        hasBalance: false,
        currentBalance: 0,
        shortfall: requiredAmount,
      }
    }
  }

  static async deductBalance(
    userId: string,
    amount: number,
    description: string,
    metadata?: Record<string, unknown>
  ): Promise<DeductResult> {
    try {
      const balanceCheck = await this.checkBalance(userId, amount)
      if (!balanceCheck.hasBalance) {
        return {
          success: false,
          error: "Insufficient balance",
        }
      }

      const userResult = await db.select({ balance: users.balance }).from(users)
        .where(eq(users.id, userId))
        .limit(1)

      const currentBalance = userResult[0]?.balance || 0
      const newBalance = currentBalance - amount

      await db.insert(billingTransactions).values({
          id: crypto.randomUUID(),
        userId,
        kind: "deduction",
        direction: "out",
        amount,
        balanceBefore: currentBalance,
        balanceAfter: newBalance,
        description,
        metadata: metadata ? JSON.stringify(metadata) : null,
      })

      await db.update(users)
        .set({ balance: newBalance })
        .where(eq(users.id, userId))

      return {
        success: true,
        newBalance,
      }
    } catch (error) {
      console.error("[GenerateBillingService] Error deducting balance:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to deduct balance",
      }
    }
  }

  static getCostBreakdown(provider: string, model: string): CostBreakdown {
    if (provider === "v0") {
      return {
        provider: "v0",
        model: model,
        costPerRequest: SWIFT_PUBLIC_PRICE_IDR,
        totalCost: SWIFT_PUBLIC_PRICE_IDR,
        currency: "IDR",
      }
    }

    if (provider === "orchestrator") {
      return {
        provider: "orchestrator",
        model: model,
        costPerRequest: SWIFT_PUBLIC_PRICE_IDR,
        totalCost: SWIFT_PUBLIC_PRICE_IDR,
        currency: "IDR",
      }
    }

    return {
      provider,
      model,
      costPerRequest: 0,
      totalCost: 0,
      currency: "IDR",
    }
  }

  static async logUsage(
    userId: string,
    provider: string,
    model: string,
    status: "SUCCESS" | "FAILED",
    errorMessage?: string
  ): Promise<void> {
    try {
      const modelConfig = await db.select().from(modelConfigs)
        .where(eq(modelConfigs.provider, provider))
        .limit(1)

      const matchingConfig = modelConfig.length > 0
        ? modelConfig
        : await db.select().from(modelConfigs)
            .where(eq(modelConfigs.modelName, model))
            .limit(1)

      if (matchingConfig.length === 0) {
        console.warn("[GenerateBillingService] No model config found for", { provider, model })
        return
      }

      await db.insert(usageLogs).values({
          id: crypto.randomUUID(),
        userId,
        provider,
        model,
        status,
        modelConfigId: matchingConfig[0].id,
        cost: 0,
        prompt: "",
        errorMessage: errorMessage || null,
      })
    } catch (error) {
      console.error("[GenerateBillingService] Error logging usage:", error)
    }
  }
}
