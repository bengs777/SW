import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { BillingService } from "@/lib/services/billing.service"

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const developerOwnerEmail = () => normalizeEmail(env.devOwnerEmail)

const isDeveloperOwnerEmail = (email?: string | null) => {
  if (!email) {
    return false
  }

  return normalizeEmail(email) === developerOwnerEmail()
}

const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  name: true,
  image: true,
} as const

export const CREDIT_GRANT_INCLUDE = {
  fromUser: { select: USER_SUMMARY_SELECT },
  toUser: { select: USER_SUMMARY_SELECT },
  createdBy: { select: USER_SUMMARY_SELECT },
  reversedBy: { select: USER_SUMMARY_SELECT },
  billingTransactions: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      userId: true,
      grantId: true,
      actorUserId: true,
      counterpartyUserId: true,
      kind: true,
      direction: true,
      amount: true,
      balanceBefore: true,
      balanceAfter: true,
      reference: true,
      provider: true,
      providerReference: true,
      description: true,
      metadata: true,
      createdAt: true,
    },
  },
} as const

export type CreditGrantRecord = Prisma.CreditGrantGetPayload<{
  include: typeof CREDIT_GRANT_INCLUDE
}>

export type DeveloperTreasuryActor = {
  id: string
  email: string
  balance: number
  isDeveloperAccount: boolean
}

type GrantMetadata = Record<string, unknown>

export type CreateDeveloperCreditGrantInput = {
  actorUserId: string
  recipientUserId: string
  amount: number
  reason: string
  note?: string | null
  idempotencyKey: string
  metadata?: GrantMetadata
}

export type ReverseDeveloperCreditGrantInput = {
  actorUserId: string
  grantId: string
  reason: string
  note?: string | null
  metadata?: GrantMetadata
}

export type ListDeveloperCreditGrantsInput = {
  limit?: number
  status?: string
  fromUserId?: string
  toUserId?: string
  createdByUserId?: string
  reference?: string
  idempotencyKey?: string
  dateFrom?: Date
  dateTo?: Date
}

export class CreditGrantService {
  static async getDeveloperTreasuryActor(actorUserId: string): Promise<DeveloperTreasuryActor> {
    const actor = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: {
        id: true,
        email: true,
        balance: true,
        isDeveloperAccount: true,
      },
    })

    if (!actor) {
      throw new Error("DEVELOPER_ACCOUNT_NOT_FOUND")
    }

    if (!actor.isDeveloperAccount || !isDeveloperOwnerEmail(actor.email)) {
      throw new Error("DEVELOPER_ACCOUNT_FORBIDDEN")
    }

    return actor
  }

  static async createGrant(
    input: CreateDeveloperCreditGrantInput
  ): Promise<{ grant: CreditGrantRecord; alreadyProcessed: boolean }> {
    return prisma.$transaction(async (tx) => {
      const existingGrant = await tx.creditGrant.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: CREDIT_GRANT_INCLUDE,
      })

      if (existingGrant) {
        return {
          grant: existingGrant,
          alreadyProcessed: true,
        }
      }

      const actor = await tx.user.findUnique({
        where: { id: input.actorUserId },
        select: {
          id: true,
          email: true,
          balance: true,
          isDeveloperAccount: true,
        },
      })

      if (!actor) {
        throw new Error("DEVELOPER_ACCOUNT_NOT_FOUND")
      }

      if (!actor.isDeveloperAccount || !isDeveloperOwnerEmail(actor.email)) {
        throw new Error("DEVELOPER_ACCOUNT_FORBIDDEN")
      }

      if (input.amount <= 0) {
        throw new Error("INVALID_GRANT_AMOUNT")
      }

      const recipient = await tx.user.findUnique({
        where: { id: input.recipientUserId },
        select: {
          id: true,
          email: true,
          balance: true,
        },
      })

      if (!recipient) {
        throw new Error("RECIPIENT_NOT_FOUND")
      }

      if (recipient.id === actor.id) {
        throw new Error("SELF_GRANT_NOT_ALLOWED")
      }

      if (actor.balance < input.amount) {
        throw new Error("INSUFFICIENT_DEVELOPER_BALANCE")
      }

      const now = new Date()
      const reference = `DEV-GRANT-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`

      const grant = await tx.creditGrant.create({
        data: {
          reference,
          fromUserId: actor.id,
          toUserId: recipient.id,
          amount: input.amount,
          reason: input.reason,
          note: input.note ?? undefined,
          status: "posted",
          createdByUserId: actor.id,
          idempotencyKey: input.idempotencyKey,
          postedAt: now,
          metadata: JSON.stringify({
            ...input.metadata,
            source: "developer_admin_grant",
            actorUserId: actor.id,
            actorEmail: actor.email,
            recipientUserId: recipient.id,
            recipientEmail: recipient.email,
            amount: input.amount,
            reason: input.reason,
            note: input.note ?? null,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      })

      const actorBalanceBefore = actor.balance
      const actorBalanceAfter = actorBalanceBefore - input.amount
      const recipientBalanceBefore = recipient.balance
      const recipientBalanceAfter = recipientBalanceBefore + input.amount

      await tx.user.update({
        where: { id: actor.id },
        data: {
          balance: {
            decrement: input.amount,
          },
        },
      })

      await tx.user.update({
        where: { id: recipient.id },
        data: {
          balance: {
            increment: input.amount,
          },
        },
      })

      await BillingService.recordBalanceTransaction(tx, {
        userId: actor.id,
        kind: "developer_grant",
        direction: "debit",
        amount: input.amount,
        balanceBefore: actorBalanceBefore,
        balanceAfter: actorBalanceAfter,
        reference: `developer-grant:${grant.reference}:debit`,
        provider: "internal",
        description: `Developer grant to ${recipient.email}`,
        metadata: JSON.stringify({
          grantId: grant.id,
          reference: grant.reference,
          actorUserId: actor.id,
          actorEmail: actor.email,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          amount: input.amount,
          reason: input.reason,
          note: input.note ?? null,
        }),
        grantId: grant.id,
        actorUserId: actor.id,
        counterpartyUserId: recipient.id,
      })

      await BillingService.recordBalanceTransaction(tx, {
        userId: recipient.id,
        kind: "developer_grant",
        direction: "credit",
        amount: input.amount,
        balanceBefore: recipientBalanceBefore,
        balanceAfter: recipientBalanceAfter,
        reference: `developer-grant:${grant.reference}:credit`,
        provider: "internal",
        description: `Developer grant from ${actor.email}`,
        metadata: JSON.stringify({
          grantId: grant.id,
          reference: grant.reference,
          actorUserId: actor.id,
          actorEmail: actor.email,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          amount: input.amount,
          reason: input.reason,
          note: input.note ?? null,
        }),
        grantId: grant.id,
        actorUserId: actor.id,
        counterpartyUserId: recipient.id,
      })

      const createdGrant = await tx.creditGrant.findUnique({
        where: { id: grant.id },
        include: CREDIT_GRANT_INCLUDE,
      })

      return {
        grant: (createdGrant ?? grant) as CreditGrantRecord,
        alreadyProcessed: false,
      }
    })
  }

  static async reverseGrant(
    input: ReverseDeveloperCreditGrantInput
  ): Promise<{ grant: CreditGrantRecord; alreadyProcessed: boolean }> {
    return prisma.$transaction(async (tx) => {
      const actor = await tx.user.findUnique({
        where: { id: input.actorUserId },
        select: {
          id: true,
          email: true,
          balance: true,
          isDeveloperAccount: true,
        },
      })

      if (!actor) {
        throw new Error("DEVELOPER_ACCOUNT_NOT_FOUND")
      }

      if (!actor.isDeveloperAccount || !isDeveloperOwnerEmail(actor.email)) {
        throw new Error("DEVELOPER_ACCOUNT_FORBIDDEN")
      }

      const grant = await tx.creditGrant.findUnique({
        where: { id: input.grantId },
        include: CREDIT_GRANT_INCLUDE,
      })

      if (!grant) {
        throw new Error("GRANT_NOT_FOUND")
      }

      if (grant.status === "reversed") {
        return {
          grant,
          alreadyProcessed: true,
        }
      }

      if (grant.status !== "posted") {
        throw new Error("GRANT_NOT_REVERSIBLE")
      }

      const recipient = await tx.user.findUnique({
        where: { id: grant.toUserId },
        select: {
          id: true,
          email: true,
          balance: true,
        },
      })

      if (!recipient) {
        throw new Error("RECIPIENT_NOT_FOUND")
      }

      if (recipient.balance < grant.amount) {
        throw new Error("RECIPIENT_INSUFFICIENT_BALANCE")
      }

      const actorBalanceBefore = actor.balance
      const actorBalanceAfter = actorBalanceBefore + grant.amount
      const recipientBalanceBefore = recipient.balance
      const recipientBalanceAfter = recipientBalanceBefore - grant.amount
      const now = new Date()

      await tx.user.update({
        where: { id: recipient.id },
        data: {
          balance: {
            decrement: grant.amount,
          },
        },
      })

      await tx.user.update({
        where: { id: actor.id },
        data: {
          balance: {
            increment: grant.amount,
          },
        },
      })

      await tx.creditGrant.update({
        where: { id: grant.id },
        data: {
          status: "reversed",
          reversedAt: now,
          reversedByUserId: actor.id,
          metadata: JSON.stringify({
            ...(grant.metadata ? { originalMetadata: grant.metadata } : {}),
            reversal: {
              reversedAt: now.toISOString(),
              reversedByUserId: actor.id,
              reversedByEmail: actor.email,
              reason: input.reason,
              note: input.note ?? null,
            },
          }),
        },
      })

      await BillingService.recordBalanceTransaction(tx, {
        userId: recipient.id,
        kind: "developer_grant_reversal",
        direction: "debit",
        amount: grant.amount,
        balanceBefore: recipientBalanceBefore,
        balanceAfter: recipientBalanceAfter,
        reference: `developer-grant:${grant.reference}:reversal:debit`,
        provider: "internal",
        description: input.reason,
        metadata: JSON.stringify({
          grantId: grant.id,
          reference: grant.reference,
          actorUserId: actor.id,
          actorEmail: actor.email,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          amount: grant.amount,
          reason: input.reason,
          note: input.note ?? null,
        }),
        grantId: grant.id,
        actorUserId: actor.id,
        counterpartyUserId: recipient.id,
      })

      await BillingService.recordBalanceTransaction(tx, {
        userId: actor.id,
        kind: "developer_grant_reversal",
        direction: "credit",
        amount: grant.amount,
        balanceBefore: actorBalanceBefore,
        balanceAfter: actorBalanceAfter,
        reference: `developer-grant:${grant.reference}:reversal:credit`,
        provider: "internal",
        description: input.reason,
        metadata: JSON.stringify({
          grantId: grant.id,
          reference: grant.reference,
          actorUserId: actor.id,
          actorEmail: actor.email,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          amount: grant.amount,
          reason: input.reason,
          note: input.note ?? null,
        }),
        grantId: grant.id,
        actorUserId: actor.id,
        counterpartyUserId: recipient.id,
      })

      const updatedGrant = await tx.creditGrant.findUnique({
        where: { id: grant.id },
        include: CREDIT_GRANT_INCLUDE,
      })

      return {
        grant: (updatedGrant ?? grant) as CreditGrantRecord,
        alreadyProcessed: false,
      }
    })
  }

  static async listGrants(filters: ListDeveloperCreditGrantsInput = {}) {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 100)

    const where: Prisma.CreditGrantWhereInput = {}

    if (filters.status) {
      where.status = filters.status
    }

    if (filters.fromUserId) {
      where.fromUserId = filters.fromUserId
    }

    if (filters.toUserId) {
      where.toUserId = filters.toUserId
    }

    if (filters.createdByUserId) {
      where.createdByUserId = filters.createdByUserId
    }

    if (filters.reference) {
      where.reference = filters.reference
    }

    if (filters.idempotencyKey) {
      where.idempotencyKey = filters.idempotencyKey
    }

    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {}

      if (filters.dateFrom) {
        where.createdAt.gte = filters.dateFrom
      }

      if (filters.dateTo) {
        where.createdAt.lte = filters.dateTo
      }
    }

    const grants = await prisma.creditGrant.findMany({
      where,
      include: CREDIT_GRANT_INCLUDE,
      orderBy: {
        createdAt: "desc",
      },
      take: limit + 1,
    })

    const hasMore = grants.length > limit

    return {
      grants: hasMore ? grants.slice(0, limit) : grants,
      hasMore,
      limit,
    }
  }
}