import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { topUpOrders } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { CryptoPaymentService } from "@/lib/services/crypto-payment.service"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

const VerifySchema = z.object({
  topUpOrderId: z.string().cuid(),
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
})

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`crypto-verify:${session.email}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: "Too many verification attempts. Please wait." }, { status: 429 })
  }

  try {
    const body = VerifySchema.parse(await request.json())

    const topUpOrder = await db.query.topUpOrders.findFirst({
      where: eq(topUpOrders.id, body.topUpOrderId),
      with: {
        user: true,
        cryptoPayment: true,
      },
    }) as { user: { email: string }; cryptoPayment: unknown } | undefined

    if (!topUpOrder || topUpOrder.user.email !== session.email) {
      return NextResponse.json({ error: "TopUpOrder not found" }, { status: 404 })
    }

    if (!topUpOrder.cryptoPayment) {
      return NextResponse.json({ error: "CryptoPayment not found" }, { status: 404 })
    }

    const result = await CryptoPaymentService.finalizePayment(body.topUpOrderId, body.transactionHash)

    const updatedOrder = await db.query.topUpOrders.findFirst({
      where: eq(topUpOrders.id, body.topUpOrderId),
      with: {
        cryptoPayment: true,
      },
    }) as { status: string; cryptoPayment: { status: string; confirmations: number } | null } | undefined

    return NextResponse.json({
      success: result,
      status: updatedOrder?.status,
      cryptoStatus: updatedOrder?.cryptoPayment?.status,
      confirmations: updatedOrder?.cryptoPayment?.confirmations,
      message: result ? "Payment confirmed" : "Waiting for confirmations",
    })
  } catch (error) {
    console.error("Verify crypto payment error:", error)
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", details: error.errors }, { status: 400 })
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
