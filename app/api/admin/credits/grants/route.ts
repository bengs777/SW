import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import {
  CreditGrantService,
  type CreditGrantRecord,
} from "@/lib/services/credit-grant.service"

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const GrantSchema = z
  .object({
    recipientUserId: z.string().trim().min(1).optional(),
    recipientEmail: z.string().trim().email().optional(),
    amount: z.coerce.number().int().positive().max(1_000_000),
    reason: z.string().trim().min(3).max(200),
    note: z.string().trim().max(500).optional().default(""),
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .refine((value) => Boolean(value.recipientUserId || value.recipientEmail), {
    message: "Recipient user id or email is required",
    path: ["recipientUserId"],
  })

const ListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  status: z.string().trim().optional(),
  fromUserId: z.string().trim().optional(),
  toUserId: z.string().trim().optional(),
  createdByUserId: z.string().trim().optional(),
  reference: z.string().trim().optional(),
  idempotencyKey: z.string().trim().optional(),
  dateFrom: z.string().trim().datetime().optional(),
  dateTo: z.string().trim().datetime().optional(),
})

function mapGrantError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  switch (message) {
    case "DEVELOPER_ACCOUNT_NOT_FOUND":
      return NextResponse.json({ error: "Developer account not found" }, { status: 404 })
    case "DEVELOPER_ACCOUNT_FORBIDDEN":
      return NextResponse.json({ error: "Developer access required" }, { status: 403 })
    case "RECIPIENT_NOT_FOUND":
      return NextResponse.json({ error: "Recipient not found" }, { status: 404 })
    case "SELF_GRANT_NOT_ALLOWED":
      return NextResponse.json({ error: "Self grant is not allowed" }, { status: 400 })
    case "INVALID_GRANT_AMOUNT":
      return NextResponse.json({ error: "Grant amount must be greater than zero" }, { status: 400 })
    case "INSUFFICIENT_DEVELOPER_BALANCE":
      return NextResponse.json({ error: "Developer treasury balance is insufficient" }, { status: 409 })
    case "GRANT_NOT_FOUND":
      return NextResponse.json({ error: "Grant not found" }, { status: 404 })
    case "GRANT_NOT_REVERSIBLE":
      return NextResponse.json({ error: "Grant is not reversible" }, { status: 409 })
    case "RECIPIENT_INSUFFICIENT_BALANCE":
      return NextResponse.json({ error: "Recipient balance is already lower than grant amount" }, { status: 409 })
    default:
      return NextResponse.json({ error: message || "Developer grant failed" }, { status: 500 })
  }
}

async function requireDeveloperTreasuryActor() {
  const session = await auth()

  if (!session?.user?.email) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const sessionEmail = normalizeEmail(session.user.email)
  if (sessionEmail !== normalizeEmail(env.devOwnerEmail)) {
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

export async function GET(request: NextRequest) {
  const actorResult = await requireDeveloperTreasuryActor()
  if ("error" in actorResult) {
    return actorResult.error
  }

  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = ListSchema.safeParse({
      limit: searchParams.get("limit") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      fromUserId: searchParams.get("fromUserId") ?? undefined,
      toUserId: searchParams.get("toUserId") ?? undefined,
      createdByUserId: searchParams.get("createdByUserId") ?? undefined,
      reference: searchParams.get("reference") ?? undefined,
      idempotencyKey: searchParams.get("idempotencyKey") ?? undefined,
      dateFrom: searchParams.get("dateFrom") ?? undefined,
      dateTo: searchParams.get("dateTo") ?? undefined,
    })

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid filter parameters" },
        { status: 400 }
      )
    }

    const result = await CreditGrantService.listGrants({
      limit: parsed.data.limit,
      status: parsed.data.status,
      fromUserId: parsed.data.fromUserId,
      toUserId: parsed.data.toUserId,
      createdByUserId: parsed.data.createdByUserId,
      reference: parsed.data.reference,
      idempotencyKey: parsed.data.idempotencyKey,
      dateFrom: parsed.data.dateFrom ? new Date(parsed.data.dateFrom) : undefined,
      dateTo: parsed.data.dateTo ? new Date(parsed.data.dateTo) : undefined,
    })

    return NextResponse.json({
      grants: result.grants.map(serializeGrant),
      hasMore: result.hasMore,
      limit: result.limit,
    })
  } catch (error) {
    return mapGrantError(error)
  }
}

export async function POST(request: NextRequest) {
  const actorResult = await requireDeveloperTreasuryActor()
  if ("error" in actorResult) {
    return actorResult.error
  }

  try {
    const body = GrantSchema.parse(await request.json())

    const recipient = body.recipientUserId
      ? await prisma.user.findUnique({
          where: { id: body.recipientUserId },
          select: { id: true, email: true },
        })
      : await prisma.user.findUnique({
          where: { email: normalizeEmail(body.recipientEmail || "") },
          select: { id: true, email: true },
        })

    if (!recipient) {
      return NextResponse.json({ error: "Recipient not found" }, { status: 404 })
    }

    const result = await CreditGrantService.createGrant({
      actorUserId: actorResult.actor.id,
      recipientUserId: recipient.id,
      amount: body.amount,
      reason: body.reason,
      note: body.note || null,
      idempotencyKey: body.idempotencyKey,
      metadata: {
        actorEmail: actorResult.actor.email,
        recipientEmail: recipient.email,
      },
    })

    return NextResponse.json(
      {
        grant: serializeGrant(result.grant),
        alreadyProcessed: result.alreadyProcessed,
      },
      { status: result.alreadyProcessed ? 200 : 201 }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid grant request" },
        { status: 400 }
      )
    }

    return mapGrantError(error)
  }
}