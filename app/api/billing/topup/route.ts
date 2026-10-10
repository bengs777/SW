import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession } from "@/auth"
import { TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { isBillingPlanId } from "@/lib/billing/plans"
import { env } from "@/lib/env"
import { db } from "@/lib/db/client"
import { workspaceMembers } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { BillingService } from "@/lib/services/billing.service"
import {
  PakasirService,
  PakasirConfigurationError,
  PakasirTimeoutError,
  PakasirUnavailableError,
  PakasirUpstreamError,
} from "@/lib/services/pakasir.service"
import { UserService } from "@/lib/services/user.service"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

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

function buildReference(prefix = "TOPUP") {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`
}

function buildCustomerName(name: string | null | undefined, email: string) {
  const trimmed = name?.trim()
  if (trimmed) {
    return trimmed
  }

  return email.split("@")[0] || "Swift User"
}

function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== "string") {
    return "Payment provider error. Please try again later."
  }
  return (
    message
      .replace(/[a-zA-Z0-9_-]{24,}/g, "[REDACTED]")
      .replace(/https?:\/\/[^\s]+/g, "[URL]")
      .trim() || "Payment provider error. Please try again later."
  )
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`topup:${session.email}`, { maxPerMinute: 5, maxPerHour: 30 })
  } catch {
    return NextResponse.json({ error: "Too many top-up requests. Please wait." }, { status: 429 })
  }

  try {
    const body = TopupSchema.parse(await request.json())

    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.email,
      session.name ?? null,
      session.image ?? null
    )

    if (body.purchaseType === "subscription") {
      if (!isBillingPlanId(body.planId) || body.planId === "free") {
        return NextResponse.json({ error: "Invalid billing plan" }, { status: 400 })
      }

      if (!body.workspaceId) {
        return NextResponse.json({ error: "Workspace is required for plan purchases" }, { status: 400 })
      }

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, body.workspaceId),
          eq(workspaceMembers.userId, user.id)
        ),
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

    const isExplicitSimulator =
      process.env.ENABLE_BILLING_SIMULATOR === "true" ||
      process.env.ALLOW_BILLING_SIMULATOR === "true"

    if (!PakasirService.isConfigured()) {
      if (!isExplicitSimulator) {
        return NextResponse.json(
          {
            error:
              "Payment gateway Pakasir belum aktif. Mohon lengkapi PAKASIR_SLUG dan PAKASIR_API_KEY di file .env.local untuk memunculkan pembayaran QRIS Pakasir.",
          },
          { status: 503 }
        )
      }

      // Explicit Simulator Mode (hanya jika ENABLE_BILLING_SIMULATOR=true):
      const reference = buildReference("SIM")
      const customerName = buildCustomerName(user.name, user.email)
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

      await BillingService.createTopUpOrder({
        userId: user.id,
        reference,
        amount: body.amount,
        provider: "sandbox",
        customerName,
        customerEmail: user.email,
        payload: JSON.stringify({
          source: body.source,
          note: body.note || "Development sandbox top up",
          purchaseType: body.purchaseType,
          planId: body.planId || null,
          workspaceId: body.workspaceId || null,
          requestedAmount: body.amount,
          sandbox: true,
        }),
        status: "pending",
        expiresAt,
      })

      const finalization = await BillingService.finalizeTopUpOrder({
        reference,
        providerReference: `SANDBOX-${reference}`,
        paymentCode: "SANDBOX-PAID",
        response: JSON.stringify({
          provider: "sandbox",
          mode: "simulator",
          settledAt: new Date().toISOString(),
        }),
        amount: body.amount,
        paidAt: new Date(),
      })

      return NextResponse.json({
        success: true,
        topupMinimum: TOPUP_MINIMUM,
        purchaseType: body.purchaseType,
        planId: body.planId || null,
        order: {
          id: finalization.order.id,
          reference: finalization.order.reference,
          amount: finalization.order.amount,
          status: "paid",
          provider: "sandbox",
          providerReference: `SANDBOX-${reference}`,
          checkoutUrl: null,
          paymentCode: "SANDBOX-PAID",
          createdAt: finalization.order.createdAt,
          expiresAt: finalization.order.expiresAt,
        },
        checkoutUrl: null,
        paymentCode: "SANDBOX-PAID",
        sandbox: true,
      })
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
          id: order[0].id,
          reference: order[0].reference,
          amount: order[0].amount,
          status: order[0].status,
          provider: order[0].provider,
          providerReference: order[0].providerReference,
          checkoutUrl: order[0].checkoutUrl,
          paymentCode: order[0].paymentCode,
          createdAt: order[0].createdAt,
          expiresAt: order[0].expiresAt,
        },
        checkoutUrl: order[0].checkoutUrl,
        paymentCode: order[0].paymentCode,
      })
    } catch (error) {
      if (isExplicitSimulator) {
        console.warn("[Billing] Pakasir upstream error, auto-settling via explicit simulator flag:", error)
        try {
          const finalization = await BillingService.finalizeTopUpOrder({
            reference,
            providerReference: `SANDBOX-${reference}`,
            paymentCode: "SANDBOX-PAID",
            response: JSON.stringify({
              provider: "sandbox_fallback",
              upstreamError: error instanceof Error ? error.message : "Upstream error",
              settledAt: new Date().toISOString(),
            }),
            amount: body.amount,
            paidAt: new Date(),
          })

          return NextResponse.json({
            success: true,
            topupMinimum: TOPUP_MINIMUM,
            purchaseType: body.purchaseType,
            planId: body.planId || null,
            order: {
              id: finalization.order.id,
              reference: finalization.order.reference,
              amount: finalization.order.amount,
              status: "paid",
              provider: "sandbox",
              providerReference: `SANDBOX-${reference}`,
              checkoutUrl: null,
              paymentCode: "SANDBOX-PAID",
              createdAt: finalization.order.createdAt,
              expiresAt: finalization.order.expiresAt,
            },
            checkoutUrl: null,
            paymentCode: "SANDBOX-PAID",
            sandbox: true,
          })
        } catch (simError) {
          console.error("[Billing] Failed fallback simulation:", simError)
        }
      }

      let httpStatus = 502
      let clientMessage = "Payment provider error. Please try again later."
      const rawMessage = error instanceof Error ? error.message : "Failed to create Pakasir invoice"

      if (error instanceof PakasirConfigurationError) {
        httpStatus = 503
        clientMessage = "Payment service is currently unavailable. Payment provider is not configured."
      } else if (error instanceof PakasirTimeoutError) {
        httpStatus = 504
        clientMessage = "Payment provider request timed out. Please try again."
      } else if (error instanceof PakasirUnavailableError) {
        httpStatus = 503
        clientMessage = "Payment service is currently unavailable. Please try again later."
      } else if (error instanceof PakasirUpstreamError) {
        if (error.upstreamStatus === 404 || /project not found/i.test(error.message)) {
          httpStatus = 503
          clientMessage = "Payment service is currently unavailable. Merchant project not found."
        } else if (error.upstreamStatus >= 500) {
          httpStatus = 502
          clientMessage = "Payment provider gateway error. Please try again later."
        } else {
          httpStatus = 502
          clientMessage = sanitizeErrorMessage(error.message)
        }
      } else if (error instanceof Error) {
        clientMessage = sanitizeErrorMessage(error.message)
      }
      await BillingService.markTopUpOrderFailed(reference, sanitizeErrorMessage(rawMessage))
      return NextResponse.json({ error: clientMessage }, { status: httpStatus })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create top up order"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}