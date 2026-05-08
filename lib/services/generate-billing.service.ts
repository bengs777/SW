import { prisma } from "@/lib/db/client"

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
  /**
   * Check if user has sufficient balance for a generation request
   */
  static async checkBalance(userId: string, requiredAmount: number): Promise<BalanceCheckResult> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      })

      const currentBalance = user?.balance || 0
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

  /**
   * Deduct balance from user account for successful generation
   */
  static async deductBalance(
    userId: string,
    amount: number,
    description: string,
    metadata?: Record<string, unknown>
  ): Promise<DeductResult> {
    try {
      // Check balance first
      const balanceCheck = await this.checkBalance(userId, amount)
      if (!balanceCheck.hasBalance) {
        return {
          success: false,
          error: "Insufficient balance",
        }
      }

      // Get current user balance
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      })

      const currentBalance = user?.balance || 0
      const newBalance = currentBalance - amount

      // Create billing transaction
      await prisma.billingTransaction.create({
        data: {
          userId,
          kind: "deduction",
          direction: "out",
          amount,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          description,
          metadata: metadata ? JSON.stringify(metadata) : null,
        },
      })

      // Update user balance
      await prisma.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      })

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

  /**
   * Get cost breakdown for a model/provider combination
   */
  static getCostBreakdown(provider: string, model: string): CostBreakdown {
    // V0 provider: 2000 IDR per request
    if (provider === "v0") {
      return {
        provider: "v0",
        model: model,
        costPerRequest: 2000,
        totalCost: 2000,
        currency: "IDR",
      }
    }

    // Orchestrator provider: 2000 IDR per request
    if (provider === "orchestrator") {
      return {
        provider: "orchestrator",
        model: model,
        costPerRequest: 2000,
        totalCost: 2000,
        currency: "IDR",
      }
    }

    // Default for other providers
    return {
      provider,
      model,
      costPerRequest: 0,
      totalCost: 0,
      currency: "IDR",
    }
  }

  /**
   * Log generation usage for tracking and analytics
   */
  static async logUsage(
    userId: string,
    provider: string,
    model: string,
    status: "SUCCESS" | "FAILED",
    errorMessage?: string
  ): Promise<void> {
    try {
      // Find a model config that matches the provider and model
      const modelConfig = await prisma.modelConfig.findFirst({
        where: {
          provider,
          modelName: model,
        },
      })

      if (!modelConfig) {
        console.warn("[GenerateBillingService] No model config found for", { provider, model })
        return
      }

      await prisma.usageLog.create({
        data: {
          userId,
          provider,
          model,
          status,
          modelConfigId: modelConfig.id,
          cost: 0, // Will be set by billing operations
          prompt: "", // Not tracking full prompt in logs
          errorMessage: errorMessage || undefined,
        },
      })
    } catch (error) {
      console.error("[GenerateBillingService] Error logging usage:", error)
      // Silently fail - don't break the flow if logging fails
    }
  }
}
