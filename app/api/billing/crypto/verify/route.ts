import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { CryptoPaymentService } from "@/lib/services/crypto-payment.service"

const VerifySchema = z.object({
  topUpOrderId: z.string().cuid(),
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
})

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = VerifySchema.parse(await request.json())

    const topUpOrder = await prisma.topUpOrder.findUnique({
      where: { id: body.topUpOrderId },
      include: { user: true, cryptoPayment: true },
    })

    if (!topUpOrder || topUpOrder.user.email !== session.user.email) {
      return NextResponse.json({ error: "TopUpOrder not found" }, { status: 404 })
    }

    if (!topUpOrder.cryptoPayment) {
      return NextResponse.json({ error: "CryptoPayment not found" }, { status: 404 })
    }

    // Verify the transaction
    const result = await CryptoPaymentService.finalizePayment(body.topUpOrderId, body.transactionHash)

    const updatedOrder = await prisma.topUpOrder.findUnique({
      where: { id: body.topUpOrderId },
      include: { cryptoPayment: true },
    })

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
