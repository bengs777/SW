import { addDays } from "date-fns"
import { db } from "@/lib/db/client"
import { users, billingTransactions, topUpOrders, workspaceMembers, subscriptions, usageLogs, generationJobs, generationEvents } from "@/lib/db/schema"
import { eq, and, gte, inArray, ne, sql } from "drizzle-orm"
import { getBillingPlan, isSubscriptionPurchasePayload, parseBillingOrderPayload } from "@/lib/billing/plans"
import { releaseAiUsageQuota } from "@/lib/security/rate-limit"

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

type ReserveGenerationJobInput = {
  userId: string
  projectId: string
  prompt: string
  modelConfigId: string
  model: string
  provider: string
  cost: number
  idempotencyKey?: string | null
  requestHash?: string | null
  plan?: unknown
  context?: Record<string, unknown> | null
  maxRetries?: number
  traceId?: string | null
}

function safeStringify(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

export class BillingService {
  static async recordBalanceTransaction(
    input: BalanceTransactionInput,
    exec: Pick<typeof db, "insert"> = db
  ) {
    return exec.insert(billingTransactions).values({
      id: crypto.randomUUID(),
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
    }).returning()
  }

  static async createTopUpOrder(input: TopUpOrderInput) {
    return db.insert(topUpOrders).values({
      id: crypto.randomUUID(),
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
    }).returning()
  }

  static async updateTopUpOrder(reference: string, data: Partial<TopUpOrderInput> & { status?: string }) {
    return db.update(topUpOrders)
      .set({
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
      })
      .where(eq(topUpOrders.reference, reference))
      .returning()
  }

  static async markTopUpOrderFailed(reference: string, response: string) {
    return db.update(topUpOrders)
      .set({
        status: "failed",
        response,
      })
      .where(eq(topUpOrders.reference, reference))
      .returning()
  }

  static async finalizeTopUpOrder(input: TopUpFinalizationInput) {
    return db.transaction(async (tx) => {
      const orderResult = await tx.select().from(topUpOrders)
        .where(eq(topUpOrders.reference, input.reference))
        .limit(1)

      const order = orderResult[0]
      const purchasePayload = parseBillingOrderPayload(order?.payload)

      if (!order) {
        throw new Error("TOPUP_ORDER_NOT_FOUND")
      }

      const userResult = await tx.select({ id: users.id, balance: users.balance }).from(users)
        .where(eq(users.id, order.userId))
        .limit(1)
      const user = userResult[0]

      if (order.status === "paid") {
        return {
          order,
          alreadyProcessed: true,
          creditedBalance: user?.balance ?? 0,
        }
      }

      if (typeof input.amount === "number" && input.amount !== order.amount) {
        throw new Error("TOPUP_AMOUNT_MISMATCH")
      }

      if (isSubscriptionPurchasePayload(purchasePayload)) {
        const plan = getBillingPlan(purchasePayload.planId)

        const membershipResult = await tx.select({ id: workspaceMembers.id }).from(workspaceMembers)
          .where(and(
            eq(workspaceMembers.workspaceId, purchasePayload.workspaceId),
            eq(workspaceMembers.userId, order.userId)
          ))
          .limit(1)

        if (membershipResult.length === 0) {
          throw new Error("WORKSPACE_MEMBERSHIP_NOT_FOUND")
        }

        const claimedOrder = await tx.update(topUpOrders)
          .set({
            status: "paid",
            paidAt: input.paidAt || new Date(),
            providerReference: input.providerReference ?? order.providerReference ?? undefined,
            paymentCode: input.paymentCode ?? order.paymentCode ?? undefined,
            checkoutUrl: input.checkoutUrl ?? order.checkoutUrl ?? undefined,
            response: input.response ?? order.response ?? undefined,
          })
          .where(and(
            eq(topUpOrders.reference, order.reference),
            ne(topUpOrders.status, "paid")
          ))
          .returning()

        if (claimedOrder.length !== 1) {
          return {
            order,
            alreadyProcessed: true,
            creditedBalance: user?.balance ?? 0,
          }
        }

        const existingSub = await tx.select().from(subscriptions)
          .where(eq(subscriptions.workspaceId, purchasePayload.workspaceId))
          .limit(1)

        if (existingSub.length > 0) {
          await tx.update(subscriptions)
            .set({
              plan: plan.id,
              status: "active",
              tokensLimit: plan.tokensLimit,
              tokensUsed: 0,
              renewalDate: plan.renewalDays ? addDays(new Date(), plan.renewalDays) : null,
              canceledAt: null,
            })
            .where(eq(subscriptions.workspaceId, purchasePayload.workspaceId))
        } else {
          await tx.insert(subscriptions).values({
            id: crypto.randomUUID(),
            workspaceId: purchasePayload.workspaceId,
            plan: plan.id,
            status: "active",
            tokensLimit: plan.tokensLimit,
            tokensUsed: 0,
            renewalDate: plan.renewalDays ? addDays(new Date(), plan.renewalDays) : null,
            canceledAt: null,
          })
        }

        return {
          order: claimedOrder[0],
          alreadyProcessed: false,
          creditedBalance: user?.balance ?? 0,
          appliedPlan: plan.id,
          workspaceId: purchasePayload.workspaceId,
        }
      }

      const claimedOrder = await tx.update(topUpOrders)
        .set({
          status: "paid",
          paidAt: input.paidAt || new Date(),
          providerReference: input.providerReference ?? order.providerReference ?? undefined,
          paymentCode: input.paymentCode ?? order.paymentCode ?? undefined,
          checkoutUrl: input.checkoutUrl ?? order.checkoutUrl ?? undefined,
          response: input.response ?? order.response ?? undefined,
        })
        .where(and(
          eq(topUpOrders.reference, order.reference),
          ne(topUpOrders.status, "paid")
        ))
        .returning()

      if (claimedOrder.length !== 1) {
        return {
          order,
          alreadyProcessed: true,
          creditedBalance: user?.balance ?? 0,
        }
      }

      const balanceBefore = user?.balance ?? 0
      const balanceAfter = balanceBefore + order.amount

      await tx.update(users)
        .set({ balance: sql`${users.balance} + ${order.amount}` })
        .where(eq(users.id, order.userId))

      await this.recordBalanceTransaction({
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
      }, tx)

      return {
        order: claimedOrder[0],
        alreadyProcessed: false,
        creditedBalance: balanceAfter,
      }
    })
  }

  static async reserveBalance(userId: string, modelConfigId: string, model: string, provider: string, prompt: string, cost: number) {
    return db.transaction(async (tx) => {
      const userResult = await tx.select({ id: users.id, balance: users.balance }).from(users)
        .where(eq(users.id, userId))
        .limit(1)

      const user = userResult[0]

      if (!user) {
        throw new Error("User not found")
      }

      if (user.balance < cost) {
        throw new Error("Insufficient balance")
      }

      const balanceAfter = user.balance - cost
      const balanceUpdate = await tx.update(users)
        .set({ balance: sql`${users.balance} - ${cost}` })
        .where(and(
          eq(users.id, userId),
          gte(users.balance, cost)
        ))
        .returning()

      if (balanceUpdate.length !== 1) {
        throw new Error("Insufficient balance")
      }

      const usageLogResult = await tx.insert(usageLogs).values({
        id: crypto.randomUUID(),
        userId,
        modelConfigId,
        model,
        provider,
        cost,
        prompt,
        status: "reserved",
      }).returning()

      const usageLog = usageLogResult[0]

      await this.recordBalanceTransaction({
        userId,
        kind: "usage",
        direction: "debit",
        amount: cost,
        balanceBefore: user.balance,
        balanceAfter,
        reference: `usage:${usageLog.id}`,
        provider,
        providerReference: usageLog.id,
        description: `Reserved Rupiah balance for ${model}`,
        metadata: JSON.stringify({
          modelConfigId,
          model,
          promptLength: prompt.length,
        }),
      }, tx)

      return usageLog
    })
  }

  static async reserveGenerationJob(input: ReserveGenerationJobInput) {
    return db.transaction(async (tx) => {
      const jobResult = await tx.insert(generationJobs).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        projectId: input.projectId,
        prompt: input.prompt,
        model: input.model,
        provider: input.provider,
        idempotencyKey: input.idempotencyKey || null,
        requestHash: input.requestHash || null,
        status: "queued",
        orchestrationState: "queued",
        traceId: input.traceId || null,
        stage: "queued",
        label: "Prompt diterima",
        progress: 0,
        maxRetries: Math.max(0, input.maxRetries ?? 2),
        planJson: safeStringify(input.plan),
        contextJson: safeStringify(input.context),
      }).returning()

      const job = jobResult[0]

      const userResult = await tx.select({ id: users.id, balance: users.balance }).from(users)
        .where(eq(users.id, input.userId))
        .limit(1)

      const user = userResult[0]

      if (!user) {
        throw new Error("User not found")
      }

      if (user.balance < input.cost) {
        throw new Error("Insufficient balance")
      }

      const balanceAfter = user.balance - input.cost
      const balanceUpdate = await tx.update(users)
        .set({ balance: sql`${users.balance} - ${input.cost}` })
        .where(and(
          eq(users.id, input.userId),
          gte(users.balance, input.cost)
        ))
        .returning()

      if (balanceUpdate.length !== 1) {
        throw new Error("Insufficient balance")
      }

      const usageLogResult = await tx.insert(usageLogs).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        modelConfigId: input.modelConfigId,
        model: input.model,
        provider: input.provider,
        cost: input.cost,
        prompt: input.prompt,
        status: "reserved",
      }).returning()

      const usageLog = usageLogResult[0]

      await this.recordBalanceTransaction({
        userId: input.userId,
        kind: "usage",
        direction: "debit",
        amount: input.cost,
        balanceBefore: user.balance,
        balanceAfter,
        reference: `usage:${usageLog.id}`,
        provider: input.provider,
        providerReference: usageLog.id,
        description: `Reserved Rupiah balance for ${input.model}`,
        metadata: JSON.stringify({
          modelConfigId: input.modelConfigId,
          model: input.model,
          promptLength: input.prompt.length,
          generationJobId: job.id,
          requestHash: input.requestHash,
        }),
      }, tx)

      const context = {
        ...(input.context || {}),
        billing: {
          usageLogId: usageLog.id,
          reservedCost: input.cost,
          modelConfigId: input.modelConfigId,
        },
      }

      const updatedJob = await tx.update(generationJobs)
        .set({
          contextJson: safeStringify(context),
        })
        .where(eq(generationJobs.id, job.id))
        .returning()

      await tx.insert(generationEvents).values({
          id: crypto.randomUUID(),
        jobId: updatedJob[0].id,
        sequence: 1,
        type: "job.created",
        eventType: "job.created",
        traceId: input.traceId || null,
        stage: "queued",
        status: "queued",
        message: "Generation job queued",
        dataJson: safeStringify({
          projectId: updatedJob[0].projectId,
          provider: updatedJob[0].provider,
          model: updatedJob[0].model,
          usageLogId: usageLog.id,
          requestHash: input.requestHash,
        }),
      })

      return {
        job: updatedJob[0],
        usageLog,
      }
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
    const setClause: Record<string, unknown> = {
      status: "completed",
    }

    if (details?.provider) {
      setClause.provider = details.provider
    }

    if (details?.model) {
      setClause.model = details.model
    }

    if (typeof details?.errorMessage !== "undefined") {
      setClause.errorMessage = details.errorMessage
    }

    const updated = await db.update(usageLogs)
      .set(setClause)
      .where(and(
        eq(usageLogs.id, usageLogId),
        inArray(usageLogs.status, ["reserved", "pending", "direct"])
      ))
      .returning()

    if (updated.length !== 1) {
      const result = await db.select().from(usageLogs)
        .where(eq(usageLogs.id, usageLogId))
        .limit(1)
      return result[0] || null
    }

    const result = await db.select().from(usageLogs)
      .where(eq(usageLogs.id, usageLogId))
      .limit(1)
    return result[0] || null
  }

  static async refundReservation(usageLogId: string, userId: string, cost: number, errorMessage: string) {
    return db.transaction(async (tx) => {
      const usageLogResult = await tx.select({
        id: usageLogs.id,
        status: usageLogs.status,
        userId: usageLogs.userId,
        cost: usageLogs.cost,
        createdAt: usageLogs.createdAt,
      }).from(usageLogs)
        .where(eq(usageLogs.id, usageLogId))
        .limit(1)

      const usageLog = usageLogResult[0]

      if (!usageLog) {
        throw new Error("Usage log not found")
      }

      if (usageLog.userId !== userId) {
        throw new Error("Usage log user mismatch")
      }

      if (usageLog.status === "completed") {
        const result = await tx.select().from(usageLogs)
          .where(eq(usageLogs.id, usageLogId))
          .limit(1)
        return result[0]
      }

      if (usageLog.status === "refunded") {
        const result = await tx.select().from(usageLogs)
          .where(eq(usageLogs.id, usageLogId))
          .limit(1)
        return result[0]
      }

      const claimed = await tx.update(usageLogs)
        .set({
          status: "refunding",
          errorMessage,
        })
        .where(and(
          eq(usageLogs.id, usageLogId),
          inArray(usageLogs.status, ["reserved", "pending", "failed", "direct"]),
          sql`${usageLogs.refundedAt} IS NULL`
        ))
        .returning()

      if (claimed.length !== 1) {
        const result = await tx.select().from(usageLogs)
          .where(eq(usageLogs.id, usageLogId))
          .limit(1)
        return result[0]
      }

      const userResult = await tx.select({ id: users.id, balance: users.balance }).from(users)
        .where(eq(users.id, userId))
        .limit(1)

      const user = userResult[0]

      if (!user) {
        throw new Error("User not found")
      }

      const refundAmount = usageLog.cost || cost
      const balanceAfter = user.balance + refundAmount

      await tx.update(users)
        .set({ balance: sql`${users.balance} + ${refundAmount}` })
        .where(eq(users.id, userId))

      await this.recordBalanceTransaction({
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
      }, tx)

      const result = await tx.update(usageLogs)
        .set({
          status: "refunded",
          errorMessage,
          refundedAt: new Date(),
        })
        .where(eq(usageLogs.id, usageLogId))
        .returning()

      // Refunded attempt: hand the generation slot back so a provider outage
      // does not burn the free daily quota of the user.
      try {
        await releaseAiUsageQuota(userId, usageLog.createdAt)
      } catch (error) {
        console.warn("[billing] Failed to release generation quota:", error instanceof Error ? error.message : String(error))
      }

      return result[0]
    })
  }
}
