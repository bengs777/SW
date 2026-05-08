import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { CreditGrantService, type CreditGrantRecord } from "@/lib/services/credit-grant.service"
import { getEnv } from "@/lib/env"

// Skip static generation for dynamic admin routes
export const dynamic = "force-dynamic"

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const ReverseSchema = z.object({
  reason: z.string().trim().min(3).max(200),
  note: z.string().trim().max(500).optional().default(""),
})

function mapGrantError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  switch (message) {
    case "DEVELOPER_ACCOUNT_NOT_FOUND":
      return NextResponse.json({ error: "Developer account not found" }, { status: 404 })
    case "DEVELOPER_ACCOUNT_FORBIDDEN":
      return NextResponse.json({ error: "Developer access required" }, { status: 403 })
    case "GRANT_NOT_FOUND":
      return NextResponse.json({ error: "Grant not found" }, { status: 404 })
    case "GRANT_NOT_REVERSIBLE":
      return NextResponse.json({ error: "Grant is not reversible" }, { status: 409 })
    case "RECIPIENT_NOT_FOUND":
      return NextResponse.json({ error: "Recipient not found" }, { status: 404 })
    case "RECIPIENT_INSUFFICIENT_BALANCE":
      return NextResponse.json({ error: "Recipient balance is already lower than grant amount" }, { status: 409 })
    default:
      return NextResponse.json({ error: message || "Developer grant reversal failed" }, { status: 500 })
  }
}

async function requireDeveloperTreasuryActor() {
  const session = await auth()

  if (!session?.user?.email) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const sessionEmail = normalizeEmail(session.user.email)
  const devOwnerEmail = getEnv("DEV_OWNER_EMAIL")
  if (!devOwnerEmail || sessionEmail !== normalizeEmail(devOwnerEmail)) {
    return { error: NextResponse.json({ error: "Developer access required" }, { status: 403 }) }
  }

  const actor = await prisma.user.findUnique({
    where: { email: sessionEmail },
    select: {
      id: true,
      email: true,
      balance: true,
      isDeveloperAccount: true,
    },
  })

  if (!actor || !actor.isDeveloperAccount) {
    return { error: NextResponse.json({ error: "Developer access required" }, { status: 403 }) }
  }

  return { actor }
}

function serializeGrant(grant: CreditGrantRecord) {
  return {
    id: grant.id,
    reference: grant.reference,
    fromUser: grant.fromUser,
    toUser: grant.toUser,
    amount: grant.amount,
    reason: grant.reason,
    note: grant.note,
    status: grant.status,
    createdBy: grant.createdBy,
    reversedBy: grant.reversedBy,
    idempotencyKey: grant.idempotencyKey,
    postedAt: grant.postedAt,
    reversedAt: grant.reversedAt,
    metadata: grant.metadata,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    billingTransactions: grant.billingTransactions,
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actorResult = await requireDeveloperTreasuryActor()
  if ("error" in actorResult) {
    return actorResult.error
  }

  try {
    const { id } = await params
    const body = ReverseSchema.parse(await request.json())

    const result = await CreditGrantService.reverseGrant({
      actorUserId: actorResult.actor.id,
      grantId: id,
      reason: body.reason,
      note: body.note || null,
    })

    return NextResponse.json({
      grant: serializeGrant(result.grant),
      alreadyProcessed: result.alreadyProcessed,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid reversal request" },
        { status: 400 }
      )
    }

    return mapGrantError(error)
  }
}
