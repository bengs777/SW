import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { MIN_CRYPTO_PAYMENT_USD_CENTS } from "@/lib/billing/constants"
import { isBillingPlanId } from "@/lib/billing/plans"
import { env } from "@/lib/env"
import { prisma } from "@/lib/db/client"
import { CryptoPaymentService } from "@/lib/services/crypto-payment.service"

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
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = CreateCryptoPaymentSchema.parse(await request.json())

    if (!env.cryptoPaymentPrivateKey || !env.cryptoPaymentAddress) {
      return NextResponse.json(
        { error: "Crypto payment is not configured" },
        { status: 503 }
      )
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true, email: true, name: true },
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

    const reference = buildReference()
    const chainName = body.chainId === 56 ? "BNB Chain" : "Base"

    // Create payment request
    const paymentResponse = await CryptoPaymentService.createPaymentRequest({
      reference,
      amountInUsd: body.amountInUsd,
      chainId: body.chainId,
      chainName,
      senderAddress: "", // Will be provided by user on checkout page
    })

    // Create TopUpOrder
    const topUpOrder = await prisma.topUpOrder.create({
      data: {
        userId: user.id,
        reference,
        provider: "crypto",
        amount: body.amountInUsd, // Store in cents
        status: "pending",
        expiresAt: new Date(Date.now() + env.cryptoPaymentTimeoutMinutes * 60 * 1000),
        chainId: body.chainId,
        walletAddress: null, // Will be set during checkout
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
      },
    })

    // Create CryptoPayment record
    await prisma.cryptoPayment.create({
      data: {
        topUpOrderId: topUpOrder.id,
        chainId: body.chainId,
        chainName,
        tokenSymbol: "Native",
        amountInUsd: body.amountInUsd,
        amountInToken: paymentResponse.amountInToken,
        senderAddress: "",
        recipientAddress: env.cryptoPaymentAddress,
        transactionHash: null, // Will be set when transaction is detected
        status: "pending",
      },
    })

    return NextResponse.json({
      orderId: topUpOrder.id,
      reference: topUpOrder.reference,
      checkoutUrl: paymentResponse.checkoutUrl,
      paymentAddress: paymentResponse.paymentAddress,
      amountInToken: paymentResponse.amountInToken,
      chainId: paymentResponse.chainId,
      chainName: paymentResponse.chainName,
      expiresAt: topUpOrder.expiresAt,
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
