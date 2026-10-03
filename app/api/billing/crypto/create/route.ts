import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession } from "@/auth"
import { MIN_CRYPTO_PAYMENT_USD_CENTS } from "@/lib/billing/constants"
import { isBillingPlanId } from "@/lib/billing/plans"
import { env } from "@/lib/env"
import { db } from "@/lib/db/client"
import { topUpOrders, cryptoPayments, users, workspaceMembers } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { CryptoPaymentService } from "@/lib/services/crypto-payment.service"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

const CreateCryptoPaymentSchema = z.object({
  amountInUsd: z.number().int().min(MIN_CRYPTO_PAYMENT_USD_CENTS).max(50_000_000),
  chainId: z.number().refine((v) => [56, 8453].includes(v), "Only BSC (56) and Base (8453) supported"),
  purchaseType: z.enum(["topup", "subscription"]).optional().default("topup"),
  planId: z.string().trim().optional(),
  workspaceId: z.string().trim().optional(),
  source: z.string().trim().max(80).optional().default("billing-panel"),
  note: z.string().trim().max(160).optional().default(""),
})

function buildReference() {
  return `CRYPTO-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`crypto-create:${session.email}`, { maxPerMinute: 5, maxPerHour: 30 })
  } catch {
    return NextResponse.json({ error: "Too many payment requests. Please wait." }, { status: 429 })
  }

  try {
    const body = CreateCryptoPaymentSchema.parse(await request.json())

    if (!env.cryptoPaymentPrivateKey || !env.cryptoPaymentAddress) {
      return NextResponse.json(
        { error: "Crypto payment is not configured" },
        { status: 503 }
      )
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, session.email),
    })

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

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

    const reference = buildReference()
    const chainName = body.chainId === 56 ? "BNB Chain" : "Base"

    const paymentResponse = await CryptoPaymentService.createPaymentRequest({
      reference,
      amountInUsd: body.amountInUsd,
      chainId: body.chainId,
      chainName,
      senderAddress: "",
    })

    const topUpOrder = await db.insert(topUpOrders).values({
      id: crypto.randomUUID(),
      userId: user.id,
      reference,
      provider: "crypto",
      amount: body.amountInUsd,
      status: "pending",
      expiresAt: new Date(Date.now() + env.cryptoPaymentTimeoutMinutes * 60 * 1000),
      chainId: body.chainId,
      walletAddress: null,
      tokenAmount: paymentResponse.amountInToken,
      customerName: user.name || user.email,
      customerEmail: user.email,
      payload: JSON.stringify({
        source: body.source,
        note: body.note,
        purchaseType: body.purchaseType,
        planId: body.planId || null,
        workspaceId: body.workspaceId || null,
        requestedAmount: body.amountInUsd,
      }),
    }).returning()

    await db.insert(cryptoPayments).values({
      id: crypto.randomUUID(),
      topUpOrderId: topUpOrder[0].id,
      chainId: body.chainId,
      chainName,
      tokenSymbol: "Native",
      amountInUsd: body.amountInUsd,
      amountInToken: paymentResponse.amountInToken,
      senderAddress: "",
      recipientAddress: env.cryptoPaymentAddress,
      transactionHash: null,
      status: "pending",
    })

    return NextResponse.json({
      orderId: topUpOrder[0].id,
      reference: topUpOrder[0].reference,
      checkoutUrl: paymentResponse.checkoutUrl,
      paymentAddress: paymentResponse.paymentAddress,
      amountInToken: paymentResponse.amountInToken,
      chainId: paymentResponse.chainId,
      chainName: paymentResponse.chainName,
      expiresAt: topUpOrder[0].expiresAt,
      purchaseType: body.purchaseType,
      planId: body.planId || null,
    })
  } catch (error) {
    console.error("Crypto payment creation error:", error)
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", details: error.errors }, { status: 400 })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
