import { Prisma } from "@prisma/client"
import { addDays } from "date-fns"
import { prisma } from "@/lib/db/client"
import { getBillingPlan, isSubscriptionPurchasePayload, parseBillingOrderPayload } from "@/lib/billing/plans"

type BalanceTransactionInput = {
  userId: string
  kind: string
  direction: "credit" | "debit"
  amount: number
  balanceBefore: number
  balanceAfter: number
  reference?: string | null
  provider?: string | null
  providerReference?: string | null
  description?: string | null
  metadata?: string | null
  grantId?: string | null
  actorUserId?: string | null
  counterpartyUserId?: string | null
}

type TopUpOrderInput = {
  userId: string
  reference: string
  amount: number
  provider?: string
  providerReference?: string | null
  checkoutUrl?: string | null
  paymentCode?: string | null
  customerName?: string | null
  customerEmail?: string | null
  payload?: string | null
  response?: string | null
  status?: string
  expiresAt?: Date | null
}

type TopUpFinalizationInput = {
  reference: string
  providerReference?: string | null
  paymentCode?: string | null
  response?: string | null
  checkoutUrl?: string | null
  amount?: number | null
  paidAt?: Date | null
}

export class BillingService {
  static async recordBalanceTransaction(
    tx: Prisma.TransactionClient,
    input: BalanceTransactionInput
  ) {
    return tx.billingTransaction.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        direction: input.direction,
        amount: input.amount,
        balanceBefore: input.balanceBefore,
        balanceAfter: input.balanceAfter,
        reference: input.reference ?? undefined,
        provider: input.provider ?? undefined,
        providerReference: input.providerReference ?? undefined,
        description: input.description ?? undefined,
        metadata: input.metadata ?? undefined,
        grantId: input.grantId ?? undefined,
        actorUserId: input.actorUserId ?? undefined,
        counterpartyUserId: input.counterpartyUserId ?? undefined,
      },
    })
  }

  static async createTopUpOrder(input: TopUpOrderInput) {
    return prisma.topUpOrder.create({
      data: {
        userId: input.userId,
        reference: input.reference,
        amount: input.amount,
        provider: input.provider || "pakasir",
        providerReference: input.providerReference ?? undefined,
        checkoutUrl: input.checkoutUrl ?? undefined,
        paymentCode: input.paymentCode ?? undefined,
        customerName: input.customerName ?? undefined,
        customerEmail: input.customerEmail ?? undefined,
        payload: input.payload ?? undefined,
        response: input.response ?? undefined,
        status: input.status || "pending",
        expiresAt: input.expiresAt ?? undefined,
      },
    })
  }

  static async updateTopUpOrder(reference: string, data: Partial<TopUpOrderInput> & { status?: string }) {
    return prisma.topUpOrder.update({
      where: { reference },
      data: {
        amount: data.amount ?? undefined,
        provider: data.provider ?? undefined,
        providerReference: data.providerReference ?? undefined,
        checkoutUrl: data.checkoutUrl ?? undefined,
        paymentCode: data.paymentCode ?? undefined,
        customerName: data.customerName ?? undefined,
        customerEmail: data.customerEmail ?? undefined,
        payload: data.payload ?? undefined,
        response: data.response ?? undefined,
        status: data.status ?? undefined,
        expiresAt: data.expiresAt ?? undefined,
      },
    })
  }

  static async markTopUpOrderFailed(reference: string, response: string) {
    return prisma.topUpOrder.update({
      where: { reference },
      data: {
        status: "failed",
        response,
      },
    })
  }

  static async finalizeTopUpOrder(input: TopUpFinalizationInput) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.topUpOrder.findUnique({
        where: { reference: input.reference },
        include: {
          user: {
            select: {
              id: true,
              balance: true,
            },
          },
        },
      })

      const purchasePayload = parseBillingOrderPayload(order?.payload)

      if (!order) {
        throw new Error("TOPUP_ORDER_NOT_FOUND")
      }

      if (order.status === "paid") {
        return {
          order,
          alreadyProcessed: true,
          creditedBalance: order.user.balance,
        }
      }

      if (typeof input.amount === "number" && input.amount !== order.amount) {
        throw new Error("TOPUP_AMOUNT_MISMATCH")
      }

      if (isSubscriptionPurchasePayload(purchasePayload)) {
        const plan = getBillingPlan(purchasePayload.planId)

        const membership = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: purchasePayload.workspaceId,
              userId: order.userId,
            },
          },
          select: {
            id: true,
          },
        })

        if (!membership) {
          throw new Error("WORKSPACE_MEMBERSHIP_NOT_FOUND")
        }

        await tx.subscription.upsert({
          where: { workspaceId: purchasePayload.workspaceId },
          create: {
            workspaceId: purchasePayload.workspaceId,
            plan: plan.id,
            status: "active",
            tokensLimit: plan.tokensLimit,
            tokensUsed: 0,
            renewalDate: plan.renewalDays ? addDays(new Date(), plan.renewalDays) : null,
            canceledAt: null,
          },
          update: {
            plan: plan.id,
            status: "active",
            tokensLimit: plan.tokensLimit,
            tokensUsed: 0,
            renewalDate: plan.renewalDays ? addDays(new Date(), plan.renewalDays) : null,
            canceledAt: null,
          },
        })

        const updatedOrder = await tx.topUpOrder.update({
          where: { reference: order.reference },
          data: {
            status: "paid",
            paidAt: input.paidAt || new Date(),
            providerReference: input.providerReference ?? order.providerReference ?? undefined,
            paymentCode: input.paymentCode ?? order.paymentCode ?? undefined,
            checkoutUrl: input.checkoutUrl ?? order.checkoutUrl ?? undefined,
            response: input.response ?? order.response ?? undefined,
          },
        })

        return {
          order: updatedOrder,
          alreadyProcessed: false,
          creditedBalance: order.user.balance,
          appliedPlan: plan.id,
          workspaceId: purchasePayload.workspaceId,
        }
      }

      const balanceBefore = order.user.balance
      const balanceAfter = balanceBefore + order.amount

      await tx.user.update({
        where: { id: order.userId },
        data: {
          balance: {
            increment: order.amount,
          },
        },
      })

      const updatedOrder = await tx.topUpOrder.update({
        where: { reference: order.reference },
        data: {
          status: "paid",
          paidAt: input.paidAt || new Date(),
          providerReference: input.providerReference ?? order.providerReference ?? undefined,
          paymentCode: input.paymentCode ?? order.paymentCode ?? undefined,
          checkoutUrl: input.checkoutUrl ?? order.checkoutUrl ?? undefined,
          response: input.response ?? order.response ?? undefined,
        },
      })

      await this.recordBalanceTransaction(tx, {
        userId: order.userId,
        kind: "topup",
        direction: "credit",
        amount: order.amount,
        balanceBefore,
        balanceAfter,
        reference: `topup:${order.reference}`,
        provider: order.provider,
        providerReference: input.providerReference ?? order.providerReference ?? order.reference,
        description: `Top up balance via ${order.provider}`,
        metadata: JSON.stringify({
          orderId: order.id,
          reference: order.reference,
          providerReference: input.providerReference ?? order.providerReference,
          paymentCode: input.paymentCode ?? order.paymentCode,
        }),
      })

      return {
        order: updatedOrder,
        alreadyProcessed: false,
        creditedBalance: balanceAfter,
      }
    })
  }

  static async reserveBalance(userId: string, modelConfigId: string, model: string, provider: string, prompt: string, cost: number) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, balance: true },
      })

      if (!user) {
        throw new Error("User not found")
      }

      if (user.balance < cost) {
        throw new Error("Insufficient balance")
      }

      const balanceAfter = user.balance - cost
      const balanceUpdate = await tx.user.updateMany({
        where: {
          id: userId,
          balance: {
            gte: cost,
          },
        },
        data: {
          balance: {
            decrement: cost,
          },
        },
      })

      if (balanceUpdate.count !== 1) {
        throw new Error("Insufficient balance")
      }

      const usageLog = await tx.usageLog.create({
        data: {
          userId,
          modelConfigId,
          model,
          provider,
          cost,
          prompt,
          status: "reserved",
        },
      })

      await this.recordBalanceTransaction(tx, {
        userId,
        kind: "usage",
        direction: "debit",
        amount: cost,
        balanceBefore: user.balance,
        balanceAfter,
        reference: `usage:${usageLog.id}`,
        provider,
        providerReference: usageLog.id,
        description: `Reserved prompt credits for ${model}`,
        metadata: JSON.stringify({
          modelConfigId,
          model,
          promptLength: prompt.length,
        }),
      })

      return usageLog
    })
  }

  static async markCompleted(
    usageLogId: string,
    details?: {
      provider?: string
      model?: string
      errorMessage?: string | null
    }
  ) {
    const data: {
      status: "completed"
      provider?: string
      model?: string
      errorMessage?: string | null
    } = {
      status: "completed",
    }

    if (details?.provider) {
      data.provider = details.provider
    }

    if (details?.model) {
      data.model = details.model
    }

    if (typeof details?.errorMessage !== "undefined") {
      data.errorMessage = details.errorMessage
    }

    const updated = await prisma.usageLog.updateMany({
      where: {
        id: usageLogId,
        status: {
          in: ["reserved", "pending"],
        },
      },
      data,
    })

    if (updated.count !== 1) {
      return prisma.usageLog.findUnique({
        where: { id: usageLogId },
      })
    }

    return prisma.usageLog.findUnique({
      where: { id: usageLogId },
    })
  }

  static async refundReservation(usageLogId: string, userId: string, cost: number, errorMessage: string) {
    return prisma.$transaction(async (tx) => {
      const usageLog = await tx.usageLog.findUnique({
        where: { id: usageLogId },
        select: {
          id: true,
          status: true,
          userId: true,
          cost: true,
        },
      })

      if (!usageLog) {
        throw new Error("Usage log not found")
      }

      if (usageLog.userId !== userId) {
        throw new Error("Usage log user mismatch")
      }

      if (usageLog.status === "completed") {
        return tx.usageLog.findUnique({ where: { id: usageLogId } })
      }

      if (usageLog.status === "refunded") {
        return tx.usageLog.findUnique({ where: { id: usageLogId } })
      }

      const claimed = await tx.usageLog.updateMany({
        where: {
          id: usageLogId,
          status: {
            in: ["reserved", "pending", "failed"],
          },
          refundedAt: null,
        },
        data: {
          status: "refunding",
          errorMessage,
        },
      })

      if (claimed.count !== 1) {
        return tx.usageLog.findUnique({ where: { id: usageLogId } })
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, balance: true },
      })

      if (!user) {
        throw new Error("User not found")
      }

      const refundAmount = usageLog.cost || cost
      const balanceAfter = user.balance + refundAmount

      await tx.user.update({
        where: { id: userId },
        data: {
          balance: {
            increment: refundAmount,
          },
        },
      })

      await this.recordBalanceTransaction(tx, {
        userId,
        kind: "refund",
        direction: "credit",
        amount: refundAmount,
        balanceBefore: user.balance,
        balanceAfter,
        reference: `refund:${usageLogId}`,
        provider: "internal",
        providerReference: usageLogId,
        description: errorMessage,
        metadata: JSON.stringify({
          errorMessage,
        }),
      })

      return tx.usageLog.update({
        where: { id: usageLogId },
        data: {
          status: "refunded",
          errorMessage,
          refundedAt: new Date(),
        },
      })
    })
  }
}
