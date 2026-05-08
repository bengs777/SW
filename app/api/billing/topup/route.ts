import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { isBillingPlanId } from "@/lib/billing/plans"
import { env } from "@/lib/env"
import { prisma } from "@/lib/db/client"
import { BillingService } from "@/lib/services/billing.service"
import { PakasirService } from "@/lib/services/pakasir.service"
import { UserService } from "@/lib/services/user.service"

const TOPUP_MINIMUM = TOPUP_MINIMUM_IDR
const TOPUP_MAXIMUM = 50_000_000
const PURCHASE_TYPES = ["topup", "subscription"] as const

const TopupSchema = z.object({
  amount: z.coerce.number().int().min(TOPUP_MINIMUM).max(TOPUP_MAXIMUM),
  note: z.string().trim().max(160).optional().default(""),
  source: z.string().trim().max(80).optional().default("billing-panel"),
  purchaseType: z.enum(PURCHASE_TYPES).optional().default("topup"),
  planId: z.string().trim().optional(),
  workspaceId: z.string().trim().optional(),
})

function buildReference() {
  return `TOPUP-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`
}

function buildCustomerName(name: string | null | undefined, email: string) {
  const trimmed = name?.trim()
  if (trimmed) {
    return trimmed
  }

  return email.split("@")[0] || "Swift User"
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = TopupSchema.parse(await request.json())

    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
    )

    if (body.purchaseType === "subscription") {
      if (!isBillingPlanId(body.planId) || body.planId === "free") {
        return NextResponse.json({ error: "Invalid billing plan" }, { status: 400 })
      }

      if (!body.workspaceId) {
        return NextResponse.json({ error: "Workspace is required for plan purchases" }, { status: 400 })
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: body.workspaceId,
            userId: user.id,
          },
        },
        select: {
          id: true,
        },
      })

      if (!membership) {
        return NextResponse.json({ error: "Workspace not found" }, { status: 404 })
      }
    }

    if (body.amount < TOPUP_MINIMUM) {
      return NextResponse.json(
        { error: `Top up minimum is Rp ${TOPUP_MINIMUM.toLocaleString("id-ID")}` },
        { status: 400 }
      )
    }

    if (!env.pakasirSlug || !env.pakasirApiKey) {
      return NextResponse.json(
        {
          error:
            "Pakasir is not configured. Set PAKASIR_SLUG and PAKASIR_API_KEY before creating topups.",
        },
        { status: 503 }
      )
    }

    const reference = buildReference()
    const checkoutReturnUrl = `${env.appUrl}/dashboard/settings?tab=billing`
    const webhookUrl = `${env.appUrl}/api/billing/pakasir/webhook`
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const customerName = buildCustomerName(user.name, user.email)

    await BillingService.createTopUpOrder({
      userId: user.id,
      reference,
      amount: body.amount,
      provider: "pakasir",
      customerName,
      customerEmail: user.email,
      payload: JSON.stringify({
        source: body.source,
        note: body.note,
        purchaseType: body.purchaseType,
        planId: body.planId || null,
        workspaceId: body.workspaceId || null,
        requestedAmount: body.amount,
      }),
      status: "pending",
      expiresAt,
    })

    try {
      const invoice = await PakasirService.createInvoice({
        reference,
        amount: body.amount,
        customerName,
        customerEmail: user.email,
        description: body.note || `Swift top up Rp ${body.amount.toLocaleString("id-ID")}`,
        webhookUrl,
        returnUrl: checkoutReturnUrl,
        expiresAt,
      })

      const order = await BillingService.updateTopUpOrder(reference, {
        providerReference: invoice.providerReference,
        checkoutUrl: invoice.checkoutUrl,
        paymentCode: invoice.paymentCode,
        response: invoice.rawResponse,
        status: "pending",
      })

      return NextResponse.json({
        success: true,
        topupMinimum: TOPUP_MINIMUM,
        purchaseType: body.purchaseType,
        planId: body.planId || null,
        order: {
          id: order.id,
          reference: order.reference,
          amount: order.amount,
          status: order.status,
          provider: order.provider,
          providerReference: order.providerReference,
          checkoutUrl: order.checkoutUrl,
          paymentCode: order.paymentCode,
          createdAt: order.createdAt,
          expiresAt: order.expiresAt,
        },
        checkoutUrl: order.checkoutUrl,
        paymentCode: order.paymentCode,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create Pakasir invoice"
      await BillingService.markTopUpOrderFailed(reference, message)
      return NextResponse.json({ error: message }, { status: 502 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create top up order"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}