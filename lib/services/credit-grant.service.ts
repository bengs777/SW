import { randomUUID } from "node:crypto"
import { db } from "@/lib/db/client"
import { creditGrants, users, billingTransactions } from "@/lib/db/schema"
import { eq, and, desc, gte, lte, sql } from "drizzle-orm"
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
} as const satisfies Record<string, true>

const USER_SUMMARY_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  image: users.image,
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

export type CreditGrantRecord = {
  id: string
  reference: string
  fromUserId: string
  toUserId: string
  amount: number
  reason: string
  note: string | null
  status: string
  createdByUserId: string
  reversedByUserId: string | null
  idempotencyKey: string | null
  postedAt: Date | null
  reversedAt: Date | null
  metadata: string | null
  createdAt: Date
  updatedAt: Date
  fromUser: { id: string; email: string; name: string | null; image: string | null } | null
  toUser: { id: string; email: string; name: string | null; image: string | null } | null
  createdBy: { id: string; email: string; name: string | null; image: string | null } | null
  reversedBy: { id: string; email: string; name: string | null; image: string | null } | null
  billingTransactions: Array<{
    id: string
    userId: string
    grantId: string | null
    actorUserId: string | null
    counterpartyUserId: string | null
    kind: string
    direction: string
    amount: number
    balanceBefore: number
    balanceAfter: number
    reference: string | null
    provider: string | null
    providerReference: string | null
    description: string | null
    metadata: string | null
    createdAt: Date
  }>
}

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
    const result = await db.select({
      id: users.id,
      email: users.email,
      balance: users.balance,
      isDeveloperAccount: users.isDeveloperAccount,
    }).from(users)
      .where(eq(users.id, actorUserId))
      .limit(1)

    const actor = result[0]

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
    return db.transaction(async (tx) => {
      const existingGrantResult = await tx.select().from(creditGrants)
        .where(eq(creditGrants.idempotencyKey, input.idempotencyKey))
        .limit(1)

      if (existingGrantResult.length > 0) {
        const grant = existingGrantResult[0]
        const [fromUser, toUser, createdBy, reversedBy, billingTxs] = await Promise.all([
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.fromUserId)).limit(1),
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.toUserId)).limit(1),
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.createdByUserId)).limit(1),
          grant.reversedByUserId
            ? tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.reversedByUserId)).limit(1)
            : Promise.resolve([]),
          tx.select({
            id: billingTransactions.id,
            userId: billingTransactions.userId,
            grantId: billingTransactions.grantId,
            actorUserId: billingTransactions.actorUserId,
            counterpartyUserId: billingTransactions.counterpartyUserId,
            kind: billingTransactions.kind,
            direction: billingTransactions.direction,
            amount: billingTransactions.amount,
            balanceBefore: billingTransactions.balanceBefore,
            balanceAfter: billingTransactions.balanceAfter,
            reference: billingTransactions.reference,
            provider: billingTransactions.provider,
            providerReference: billingTransactions.providerReference,
            description: billingTransactions.description,
            metadata: billingTransactions.metadata,
            createdAt: billingTransactions.createdAt,
          }).from(billingTransactions)
            .where(eq(billingTransactions.grantId, grant.id))
            .orderBy(billingTransactions.createdAt),
        ])

        return {
          grant: {
            ...grant,
            fromUser: fromUser[0] || null,
            toUser: toUser[0] || null,
            createdBy: createdBy[0] || null,
            reversedBy: reversedBy[0] || null,
            billingTransactions: billingTxs,
          },
          alreadyProcessed: true,
        }
      }

      const actorResult = await tx.select({
        id: users.id,
        email: users.email,
        balance: users.balance,
        isDeveloperAccount: users.isDeveloperAccount,
      }).from(users)
        .where(eq(users.id, input.actorUserId))
        .limit(1)

      const actor = actorResult[0]

      if (!actor) {
        throw new Error("DEVELOPER_ACCOUNT_NOT_FOUND")
      }

      if (!actor.isDeveloperAccount || !isDeveloperOwnerEmail(actor.email)) {
        throw new Error("DEVELOPER_ACCOUNT_FORBIDDEN")
      }

      if (input.amount <= 0) {
        throw new Error("INVALID_GRANT_AMOUNT")
      }

      const recipientResult = await tx.select({
        id: users.id,
        email: users.email,
        balance: users.balance,
      }).from(users)
        .where(eq(users.id, input.recipientUserId))
        .limit(1)

      const recipient = recipientResult[0]

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

      const grantResult = await tx.insert(creditGrants).values({
        id: crypto.randomUUID(),
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
      }).returning()

      const grant = grantResult[0]

      const actorBalanceBefore = actor.balance
      const actorBalanceAfter = actorBalanceBefore - input.amount
      const recipientBalanceBefore = recipient.balance
      const recipientBalanceAfter = recipientBalanceBefore + input.amount

      await tx.update(users)
        .set({ balance: sql`${users.balance} - ${input.amount}` })
        .where(eq(users.id, actor.id))

      await tx.update(users)
        .set({ balance: sql`${users.balance} + ${input.amount}` })
        .where(eq(users.id, recipient.id))

      await BillingService.recordBalanceTransaction({
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
      }, tx)

      await BillingService.recordBalanceTransaction({
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
      }, tx)

      const createdGrantResult = await tx.select().from(creditGrants)
        .where(eq(creditGrants.id, grant.id))
        .limit(1)

      const createdGrant = createdGrantResult[0]
      const [fromUser, toUser, createdBy] = await Promise.all([
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, createdGrant.fromUserId)).limit(1),
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, createdGrant.toUserId)).limit(1),
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, createdGrant.createdByUserId)).limit(1),
      ])

      return {
        grant: {
          ...createdGrant,
          fromUser: fromUser[0] || null,
          toUser: toUser[0] || null,
          createdBy: createdBy[0] || null,
          reversedBy: null,
          billingTransactions: [],
        },
        alreadyProcessed: false,
      }
    })
  }

  static async reverseGrant(
    input: ReverseDeveloperCreditGrantInput
  ): Promise<{ grant: CreditGrantRecord; alreadyProcessed: boolean }> {
    return db.transaction(async (tx) => {
      const actorResult = await tx.select({
        id: users.id,
        email: users.email,
        balance: users.balance,
        isDeveloperAccount: users.isDeveloperAccount,
      }).from(users)
        .where(eq(users.id, input.actorUserId))
        .limit(1)

      const actor = actorResult[0]

      if (!actor) {
        throw new Error("DEVELOPER_ACCOUNT_NOT_FOUND")
      }

      if (!actor.isDeveloperAccount || !isDeveloperOwnerEmail(actor.email)) {
        throw new Error("DEVELOPER_ACCOUNT_FORBIDDEN")
      }

      const grantResult = await tx.select().from(creditGrants)
        .where(eq(creditGrants.id, input.grantId))
        .limit(1)

      const grant = grantResult[0]

      if (!grant) {
        throw new Error("GRANT_NOT_FOUND")
      }

      if (grant.status === "reversed") {
        const [fromUser, toUser, createdBy, reversedBy, billingTxs] = await Promise.all([
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.fromUserId)).limit(1),
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.toUserId)).limit(1),
          tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.createdByUserId)).limit(1),
          grant.reversedByUserId
            ? tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.reversedByUserId)).limit(1)
            : Promise.resolve([]),
          tx.select({
            id: billingTransactions.id,
            userId: billingTransactions.userId,
            grantId: billingTransactions.grantId,
            actorUserId: billingTransactions.actorUserId,
            counterpartyUserId: billingTransactions.counterpartyUserId,
            kind: billingTransactions.kind,
            direction: billingTransactions.direction,
            amount: billingTransactions.amount,
            balanceBefore: billingTransactions.balanceBefore,
            balanceAfter: billingTransactions.balanceAfter,
            reference: billingTransactions.reference,
            provider: billingTransactions.provider,
            providerReference: billingTransactions.providerReference,
            description: billingTransactions.description,
            metadata: billingTransactions.metadata,
            createdAt: billingTransactions.createdAt,
          }).from(billingTransactions)
            .where(eq(billingTransactions.grantId, grant.id))
            .orderBy(billingTransactions.createdAt),
        ])

        return {
          grant: {
            ...grant,
            fromUser: fromUser[0] || null,
            toUser: toUser[0] || null,
            createdBy: createdBy[0] || null,
            reversedBy: reversedBy[0] || null,
            billingTransactions: billingTxs,
          },
          alreadyProcessed: true,
        }
      }

      if (grant.status !== "posted") {
        throw new Error("GRANT_NOT_REVERSIBLE")
      }

      const recipientResult = await tx.select({
        id: users.id,
        email: users.email,
        balance: users.balance,
      }).from(users)
        .where(eq(users.id, grant.toUserId))
        .limit(1)

      const recipient = recipientResult[0]

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

      await tx.update(users)
        .set({ balance: sql`${users.balance} - ${grant.amount}` })
        .where(eq(users.id, recipient.id))

      await tx.update(users)
        .set({ balance: sql`${users.balance} + ${grant.amount}` })
        .where(eq(users.id, actor.id))

      await tx.update(creditGrants)
        .set({
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
        })
        .where(eq(creditGrants.id, grant.id))

      await BillingService.recordBalanceTransaction({
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
      }, tx)

      await BillingService.recordBalanceTransaction({
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
      }, tx)

      const updatedGrantResult = await tx.select().from(creditGrants)
        .where(eq(creditGrants.id, grant.id))
        .limit(1)

      const updatedGrant = updatedGrantResult[0]
      const [fromUser, toUser, createdBy, reversedBy] = await Promise.all([
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, updatedGrant.fromUserId)).limit(1),
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, updatedGrant.toUserId)).limit(1),
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, updatedGrant.createdByUserId)).limit(1),
        tx.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, updatedGrant.reversedByUserId ?? "")).limit(1),
      ])

      return {
        grant: {
          ...updatedGrant,
          fromUser: fromUser[0] || null,
          toUser: toUser[0] || null,
          createdBy: createdBy[0] || null,
          reversedBy: reversedBy[0] || null,
          billingTransactions: [],
        },
        alreadyProcessed: false,
      }
    })
  }

  static async listGrants(filters: ListDeveloperCreditGrantsInput = {}) {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 100)

    const conditions = []
    if (filters.status) conditions.push(eq(creditGrants.status, filters.status))
    if (filters.fromUserId) conditions.push(eq(creditGrants.fromUserId, filters.fromUserId))
    if (filters.toUserId) conditions.push(eq(creditGrants.toUserId, filters.toUserId))
    if (filters.createdByUserId) conditions.push(eq(creditGrants.createdByUserId, filters.createdByUserId))
    if (filters.reference) conditions.push(eq(creditGrants.reference, filters.reference))
    if (filters.idempotencyKey) conditions.push(eq(creditGrants.idempotencyKey, filters.idempotencyKey))
    if (filters.dateFrom) conditions.push(gte(creditGrants.createdAt, filters.dateFrom))
    if (filters.dateTo) conditions.push(lte(creditGrants.createdAt, filters.dateTo))

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const grants = await db.select().from(creditGrants)
      .where(whereClause)
      .orderBy(desc(creditGrants.createdAt))
      .limit(limit + 1)

    const hasMore = grants.length > limit
    const limitedGrants = hasMore ? grants.slice(0, limit) : grants

    const enrichedGrants: CreditGrantRecord[] = await Promise.all(
      limitedGrants.map(async (grant) => {
        const [fromUser, toUser, createdBy, reversedBy, billingTxs] = await Promise.all([
          db.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.fromUserId)).limit(1),
          db.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.toUserId)).limit(1),
          db.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.createdByUserId)).limit(1),
          grant.reversedByUserId
            ? db.select(USER_SUMMARY_COLUMNS).from(users).where(eq(users.id, grant.reversedByUserId)).limit(1)
            : Promise.resolve([]),
          db.select({
            id: billingTransactions.id,
            userId: billingTransactions.userId,
            grantId: billingTransactions.grantId,
            actorUserId: billingTransactions.actorUserId,
            counterpartyUserId: billingTransactions.counterpartyUserId,
            kind: billingTransactions.kind,
            direction: billingTransactions.direction,
            amount: billingTransactions.amount,
            balanceBefore: billingTransactions.balanceBefore,
            balanceAfter: billingTransactions.balanceAfter,
            reference: billingTransactions.reference,
            provider: billingTransactions.provider,
            providerReference: billingTransactions.providerReference,
            description: billingTransactions.description,
            metadata: billingTransactions.metadata,
            createdAt: billingTransactions.createdAt,
          }).from(billingTransactions)
            .where(eq(billingTransactions.grantId, grant.id))
            .orderBy(billingTransactions.createdAt),
        ])

        return {
          ...grant,
          fromUser: fromUser[0] || null,
          toUser: toUser[0] || null,
          createdBy: createdBy[0] || null,
          reversedBy: reversedBy[0] || null,
          billingTransactions: billingTxs,
        }
      })
    )

    return {
      grants: enrichedGrants,
      hasMore,
      limit,
    }
  }
}
