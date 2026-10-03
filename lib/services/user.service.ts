import { db } from '@/lib/db/client'
import { users, workspaces, workspaceMembers, subscriptions, billingTransactions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'
import { MONTHLY_FREE_CREDITS_AMOUNT, SIGNUP_CREDITS_AMOUNT } from '@/lib/billing/constants'

const DEVELOPER_TREASURY_CREDITS = 1_000_000

const normalizeEmail = (email: string) => email.trim().toLowerCase()
const getDeveloperTreasuryEmail = () => normalizeEmail(env.devOwnerEmail)
const isDeveloperTreasuryEmail = (email?: string | null) => {
  if (!email) {
    return false
  }

  return normalizeEmail(email) === getDeveloperTreasuryEmail()
}

const buildInitialAccountState = (email: string) => {
  const developerAccount = isDeveloperTreasuryEmail(email)

  return {
    balance: developerAccount ? DEVELOPER_TREASURY_CREDITS : SIGNUP_CREDITS_AMOUNT,
    isDeveloperAccount: developerAccount,
    welcomeBonusGrantedAt: new Date(),
  }
}

const getCurrentMonthStartUtc = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))

export class UserService {
  static async ensureUserExists(
    email: string,
    name?: string | null,
    image?: string | null
  ) {
    const accountState = buildInitialAccountState(email)
    const normalizedEmail = normalizeEmail(email)

    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
    })

    if (existing) {
      await db.update(users)
        .set({
          name: name || undefined,
          image: image || undefined,
          ...(accountState.isDeveloperAccount ? { isDeveloperAccount: true } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id))
      return existing
    }

    const userId = crypto.randomUUID()
    await db.insert(users).values({
      id: userId,
      email: normalizedEmail,
      name,
      image,
      balance: accountState.balance,
      isDeveloperAccount: accountState.isDeveloperAccount,
      welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
    })

    return { id: userId, email: normalizedEmail, name, image }
  }

  static async findOrCreateUser(email: string, data: { name?: string | null; image?: string | null }) {
    const accountState = buildInitialAccountState(email)
    const normalizedEmail = normalizeEmail(email)

    const existing = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      with: {
        workspaces: { with: { members: true } },
      },
    })

    if (existing) {
      await db.update(users)
        .set({
          name: data.name || undefined,
          image: data.image || undefined,
          ...(accountState.isDeveloperAccount ? { isDeveloperAccount: true } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id))
      return existing
    }

    const userId = crypto.randomUUID()
    await db.insert(users).values({
      id: userId,
      email: normalizedEmail,
      name: data.name ?? null,
      image: data.image ?? null,
      balance: accountState.balance,
      isDeveloperAccount: accountState.isDeveloperAccount,
      welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
    })

    return { id: userId, email: normalizedEmail, name: data.name ?? null, image: data.image ?? null }
  }

  static async getUserWithWorkspaces(userId: string) {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        workspaces: {
          with: {
            members: { with: { user: true } },
            subscription: true,
          },
        },
        memberships: {
          with: {
            workspace: {
              with: {
                members: true,
                subscription: true,
              },
            },
          },
        },
      },
    })
  }

  static async createUserWithWorkspace(
    email: string,
    name: string | null,
    image: string | null
  ) {
    const accountState = buildInitialAccountState(email)
    const normalizedEmail = normalizeEmail(email)
    const userId = crypto.randomUUID()
    const workspaceId = crypto.randomUUID()
    const welcomeBonus = accountState.balance
    const billingKind = accountState.isDeveloperAccount ? "developer_seed" : "welcome_bonus"
    const billingReference = accountState.isDeveloperAccount
      ? `developer-seed:${normalizedEmail}`
      : `welcome-bonus:${normalizedEmail}`

    await db.insert(users).values({
      id: userId,
      email: normalizedEmail,
      name,
      image,
      balance: welcomeBonus,
      isDeveloperAccount: accountState.isDeveloperAccount,
      welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
    })

    await db.insert(billingTransactions).values({
      id: crypto.randomUUID(),
      userId,
      kind: billingKind,
      direction: "credit",
      amount: welcomeBonus,
      balanceBefore: 0,
      balanceAfter: welcomeBonus,
      reference: billingReference,
      provider: "internal",
      description: accountState.isDeveloperAccount
        ? "Developer treasury seed"
        : "One-time welcome balance for new account",
      metadata: JSON.stringify({
        source: accountState.isDeveloperAccount ? "developer_seed" : "signup",
        amount: welcomeBonus,
        isDeveloperAccount: accountState.isDeveloperAccount,
      }),
    })

    await db.insert(workspaces).values({
      id: workspaceId,
      name: `${name || 'My'} Workspace`,
      slug: `workspace-${userId.slice(0, 8)}`,
      createdBy: userId,
    })

    await db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role: 'admin',
    })

    await db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      workspaceId,
      plan: 'free',
    })

    return { id: userId, email: normalizedEmail, name, image }
  }

  static async grantMonthlyFreeCreditsIfNeeded(email: string) {
    try {
      const normalizedEmail = email.trim().toLowerCase()
      const currentMonthStart = getCurrentMonthStartUtc()

      if (isDeveloperTreasuryEmail(normalizedEmail)) {
        return
      }

      const user = await db.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
        columns: {
          id: true,
          balance: true,
          welcomeBonusGrantedAt: true,
          isDeveloperAccount: true,
        },
      })

      if (!user) {
        return
      }

      if (user.isDeveloperAccount) {
        return
      }

      if (user.welcomeBonusGrantedAt && user.welcomeBonusGrantedAt >= currentMonthStart) {
        return
      }

      const balanceBefore = user.balance
      const balanceAfter = balanceBefore + MONTHLY_FREE_CREDITS_AMOUNT
      const grantedAt = new Date()

      await db.update(users)
        .set({
          balance: balanceAfter,
          welcomeBonusGrantedAt: grantedAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))

      await db.insert(billingTransactions).values({
        id: crypto.randomUUID(),
        userId: user.id,
        kind: "free_balance",
        direction: "credit",
        amount: MONTHLY_FREE_CREDITS_AMOUNT,
        balanceBefore,
        balanceAfter,
        reference: `free-balance:${currentMonthStart.toISOString().slice(0, 7)}:${user.id}`,
        provider: "internal",
        description: "Monthly free Rupiah balance for the Free plan",
        metadata: JSON.stringify({
          source: "monthly_free_plan",
          amount: MONTHLY_FREE_CREDITS_AMOUNT,
          period: currentMonthStart.toISOString(),
        }),
      })
    } catch (error) {
      throw error
    }
  }

  static async grantWelcomeBonusIfNeeded(email: string) {
    try {
      const normalizedEmail = email.trim().toLowerCase()

      if (isDeveloperTreasuryEmail(normalizedEmail)) {
        return
      }

      const reference = `welcome-bonus:${normalizedEmail}`
      const user = await db.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
        columns: {
          id: true,
          balance: true,
          welcomeBonusGrantedAt: true,
          isDeveloperAccount: true,
        },
      })

      if (!user || user.isDeveloperAccount || user.welcomeBonusGrantedAt) {
        return
      }

      const existingBonus = await db.query.billingTransactions.findFirst({
        where: eq(billingTransactions.reference, reference),
        columns: { id: true },
      })

      if (existingBonus) {
        await db.update(users)
          .set({ welcomeBonusGrantedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, user.id))
        return
      }

      const balanceBefore = user.balance
      const balanceAfter = balanceBefore + SIGNUP_CREDITS_AMOUNT
      const grantedAt = new Date()

      await db.update(users)
        .set({
          balance: balanceAfter,
          welcomeBonusGrantedAt: grantedAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))

      await db.insert(billingTransactions).values({
        id: crypto.randomUUID(),
        userId: user.id,
        kind: "welcome_bonus",
        direction: "credit",
        amount: SIGNUP_CREDITS_AMOUNT,
        balanceBefore,
        balanceAfter,
        reference,
        provider: "internal",
        description: "One-time welcome balance for new account",
        metadata: JSON.stringify({
          source: "signup",
          amount: SIGNUP_CREDITS_AMOUNT,
        }),
      })
    } catch (error) {
      throw error
    }
  }

  static async createUserWithWorkspaceIfMissing(
    email: string,
    name: string | null,
    image: string | null
  ) {
    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, normalizedEmail),
      with: {
        memberships: { columns: { id: true } },
        workspaces: { columns: { id: true } },
      },
    })

    if (existingUser) {
      const shouldUpdateProfile =
        (typeof name === 'string' && name.trim().length > 0 && name !== existingUser.name) ||
        (typeof image === 'string' && image !== existingUser.image)
      const shouldCreateWorkspace =
        existingUser.memberships.length === 0 && existingUser.workspaces.length === 0
      const shouldMarkDeveloper = isDeveloperTreasuryEmail(normalizedEmail) && !existingUser.isDeveloperAccount

      if (!shouldUpdateProfile && !shouldCreateWorkspace && !shouldMarkDeveloper) {
        return existingUser
      }

      if (shouldUpdateProfile || shouldMarkDeveloper) {
        await db.update(users)
          .set({
            ...(typeof name === 'string' && name.trim().length > 0 && name !== existingUser.name
              ? { name }
              : {}),
            ...(typeof image === 'string' && image !== existingUser.image
              ? { image }
              : {}),
            ...(shouldMarkDeveloper ? { isDeveloperAccount: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingUser.id))
      }

      if (shouldCreateWorkspace) {
        const workspaceName = `${name || existingUser.name || normalizedEmail.split('@')[0]} Workspace`
        const workspaceId = crypto.randomUUID()

        await db.insert(workspaces).values({
          id: workspaceId,
          name: workspaceName,
          slug: `workspace-${existingUser.id.slice(0, 8)}`,
          createdBy: existingUser.id,
        })

        await db.insert(workspaceMembers).values({
          id: crypto.randomUUID(),
          workspaceId,
          userId: existingUser.id,
          role: 'admin',
        })

        await db.insert(subscriptions).values({
          id: crypto.randomUUID(),
          workspaceId,
          plan: 'free',
        })
      }

      const refreshedUser = await db.query.users.findFirst({
        where: eq(users.id, existingUser.id),
      })

      return refreshedUser ?? existingUser
    }

    return this.createUserWithWorkspace(normalizedEmail, name, image)
  }

  static async getUserById(userId: string) {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        memberships: {
          with: {
            workspace: true,
          },
        },
        workspaces: true,
      },
    })
  }
}
