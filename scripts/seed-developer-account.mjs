import nextEnv from "@next/env"
import { PrismaLibSQL } from "@prisma/adapter-libsql"
import { PrismaClient } from "@prisma/client"
import { createClient } from "@libsql/client"

const { loadEnvConfig } = nextEnv

loadEnvConfig(process.cwd())

const normalizeEmail = (value) => value.trim().toLowerCase()

const devOwnerEmail = normalizeEmail(process.env.DEV_OWNER_EMAIL || "ibnualmugni1933@gmail.com")
const seedReference = `developer-seed:${devOwnerEmail}`
const seedAmount = 1_000_000

const databaseUrl = process.env.TURSO_DATABASE_URL || ""
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || ""

if (!databaseUrl) {
  throw new Error("TURSO_DATABASE_URL is required")
}

const prismaAdapter = new PrismaLibSQL(
  createClient({
    url: databaseUrl,
    authToken: tursoAuthToken || undefined,
  })
)

const prisma = new PrismaClient({
  adapter: prismaAdapter,
  log: ["warn", "error"],
})

async function main() {
  const existingSeed = await prisma.billingTransaction.findUnique({
    where: { reference: seedReference },
    select: { id: true },
  })

  if (existingSeed) {
    console.log(`Developer treasury already seeded for ${devOwnerEmail}`)
    return
  }

  const seedAt = new Date()

  await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({
      where: { email: devOwnerEmail },
      select: {
        id: true,
        balance: true,
      },
    })

    const balanceBefore = existingUser?.balance ?? 0

    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            balance: seedAmount,
            isDeveloperAccount: true,
            welcomeBonusGrantedAt: seedAt,
          },
        })
      : await tx.user.create({
          data: {
            email: devOwnerEmail,
            name: "Swift Developer",
            balance: seedAmount,
            isDeveloperAccount: true,
            welcomeBonusGrantedAt: seedAt,
          },
        })

    const workspaceCount = await tx.workspace.count({
      where: { createdBy: user.id },
    })

    const membershipCount = await tx.workspaceMember.count({
      where: { userId: user.id },
    })

    if (workspaceCount === 0 && membershipCount === 0) {
      const workspace = await tx.workspace.create({
        data: {
          name: "Developer Treasury Workspace",
          slug: `developer-${user.id.slice(0, 8)}`,
          createdBy: user.id,
        },
      })

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: "admin",
        },
      })

      await tx.subscription.create({
        data: {
          workspaceId: workspace.id,
          plan: "free",
        },
      })
    }

    await tx.billingTransaction.create({
      data: {
        userId: user.id,
        kind: "developer_seed",
        direction: "credit",
        amount: seedAmount,
        balanceBefore,
        balanceAfter: seedAmount,
        reference: seedReference,
        provider: "internal",
        description: "Developer treasury seed",
        metadata: JSON.stringify({
          source: "seed-script",
          email: devOwnerEmail,
          amount: seedAmount,
        }),
      },
    })
  })

  console.log(`Seeded developer treasury for ${devOwnerEmail} with ${seedAmount} credits`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })