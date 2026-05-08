import { prisma } from '@/lib/db/client'
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from '@/lib/db/errors'
import { env } from '@/lib/env'
import { Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'

const FREE_CREDITS_AMOUNT = 5000
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
    balance: developerAccount ? DEVELOPER_TREASURY_CREDITS : FREE_CREDITS_AMOUNT,
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

    return prisma.user.upsert({
      where: { email },
      update: {
        name: name || undefined,
        image: image || undefined,
        ...(accountState.isDeveloperAccount ? { isDeveloperAccount: true } : {}),
      },
      create: {
        email,
        name,
        image,
        balance: accountState.balance,
        isDeveloperAccount: accountState.isDeveloperAccount,
        welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
      },
    })
  }

  static async findOrCreateUser(email: string, data: Prisma.UserCreateInput) {
    const accountState = buildInitialAccountState(email)

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: data.name ?? null,
        image: data.image ?? null,
        balance: accountState.balance,
        isDeveloperAccount: accountState.isDeveloperAccount,
        welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
      },
      update: {
        name: data.name || undefined,
        image: data.image || undefined,
        ...(accountState.isDeveloperAccount ? { isDeveloperAccount: true } : {}),
      },
      include: {
        workspaces: {
          include: {
            members: true,
          },
        },
      },
    })

    return user
  }

  static async getUserWithWorkspaces(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        workspaces: {
          include: {
            members: {
              include: {
                user: true,
              },
            },
            subscription: true,
          },
        },
        memberships: {
          include: {
            workspace: {
              include: {
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
    image: string | null,
    passwordHash?: string
  ) {
    const accountState = buildInitialAccountState(email)

    return prisma.$transaction(async (tx) => {
      const welcomeBonus = accountState.balance
      const billingKind = accountState.isDeveloperAccount ? "developer_seed" : "welcome_bonus"
      const billingReference = accountState.isDeveloperAccount
        ? `developer-seed:${normalizeEmail(email)}`
        : `welcome-bonus:${normalizeEmail(email)}`

      const user = await tx.user.create({
        data: {
          email,
          name,
          image,
          passwordHash,
          balance: welcomeBonus,
          isDeveloperAccount: accountState.isDeveloperAccount,
          welcomeBonusGrantedAt: accountState.welcomeBonusGrantedAt,
        },
      })

      await tx.billingTransaction.create({
        data: {
          userId: user.id,
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
        },
      })

      const workspace = await tx.workspace.create({
        data: {
          name: `${name || 'My'} Workspace`,
          slug: `workspace-${user.id.slice(0, 8)}`,
          createdBy: user.id,
        },
      })

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'admin',
        },
      })

      await tx.subscription.create({
        data: {
          workspaceId: workspace.id,
          plan: 'free',
        },
      })

      return user
    })
  }

  static async grantMonthlyFreeCreditsIfNeeded(email: string) {
    try {
      const normalizedEmail = email.trim().toLowerCase()
      const currentMonthStart = getCurrentMonthStartUtc()

      if (isDeveloperTreasuryEmail(normalizedEmail)) {
        return
      }

      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: {
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

      await prisma.$transaction(async (tx) => {
        const latestUser = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            id: true,
            balance: true,
            welcomeBonusGrantedAt: true,
            isDeveloperAccount: true,
          },
        })

        if (!latestUser) {
          return
        }

        if (latestUser.isDeveloperAccount) {
          return
        }

        if (latestUser.welcomeBonusGrantedAt && latestUser.welcomeBonusGrantedAt >= currentMonthStart) {
          return
        }

        const balanceBefore = latestUser.balance
        const balanceAfter = balanceBefore + FREE_CREDITS_AMOUNT
        const grantedAt = new Date()

        await tx.user.update({
          where: { id: latestUser.id },
          data: {
            balance: {
              increment: FREE_CREDITS_AMOUNT,
            },
            welcomeBonusGrantedAt: grantedAt,
          },
        })

        await tx.billingTransaction.create({
          data: {
            userId: latestUser.id,
            kind: "free_credits",
            direction: "credit",
            amount: FREE_CREDITS_AMOUNT,
            balanceBefore,
            balanceAfter,
            reference: `free-credits:${currentMonthStart.toISOString().slice(0, 7)}:${latestUser.id}`,
            provider: "internal",
            description: "Monthly free credits for the Free plan",
            metadata: JSON.stringify({
              source: "monthly_free_plan",
              amount: FREE_CREDITS_AMOUNT,
              period: currentMonthStart.toISOString(),
            }),
          },
        })
      })
    } catch (error) {
      if (isMissingRequiredTableError(error)) {
        if (shouldSoftFailMissingTable()) {
          console.warn("[user] Required database tables are not ready yet; skipping monthly free credits sync.")
          return
        }
      }

      throw error
    }
  }

  static async createUserWithWorkspaceIfMissing(
    email: string,
    name: string | null,
    image: string | null
  ) {
    const normalizedEmail = email.trim().toLowerCase()
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        isDeveloperAccount: true,
        memberships: {
          select: {
            id: true,
          },
        },
        workspaces: {
          select: {
            id: true,
          },
        },
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

      return prisma.$transaction(async (tx) => {
        if (shouldUpdateProfile || shouldMarkDeveloper) {
          await tx.user.update({
            where: { id: existingUser.id },
            data: {
              ...(typeof name === 'string' && name.trim().length > 0 && name !== existingUser.name
                ? { name }
                : {}),
              ...(typeof image === 'string' && image !== existingUser.image
                ? { image }
                : {}),
              ...(shouldMarkDeveloper ? { isDeveloperAccount: true } : {}),
            },
          })
        }

        if (shouldCreateWorkspace) {
          const workspaceName = `${name || existingUser.name || normalizedEmail.split('@')[0]} Workspace`

          const workspace = await tx.workspace.create({
            data: {
              name: workspaceName,
              slug: `workspace-${existingUser.id.slice(0, 8)}`,
              createdBy: existingUser.id,
            },
          })

          await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              userId: existingUser.id,
              role: 'admin',
            },
          })

          await tx.subscription.create({
            data: {
              workspaceId: workspace.id,
              plan: 'free',
            },
          })
        }

        const refreshedUser = await tx.user.findUnique({
          where: { id: existingUser.id },
        })

        return refreshedUser ?? existingUser
      })
    }

    return this.createUserWithWorkspace(normalizedEmail, name, image)
  }

  static async createCredentialsUserWithWorkspace(
    email: string,
    name: string,
    password: string
  ) {
    const normalizedEmail = email.trim().toLowerCase()

    if (isDeveloperTreasuryEmail(normalizedEmail)) {
      throw new Error('DEVELOPER_ACCOUNT_RESERVED')
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    })

    if (existingUser) {
      throw new Error('USER_EXISTS')
    }

    const passwordHash = await bcrypt.hash(password, 12)
    return this.createUserWithWorkspace(
      normalizedEmail,
      name,
      null,
      passwordHash
    )
  }

  static async validateCredentials(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase()
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (!user?.passwordHash) {
      return null
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      return null
    }

    return user
  }

  static async getUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
        },
        workspaces: true,
      },
    })
  }
}
