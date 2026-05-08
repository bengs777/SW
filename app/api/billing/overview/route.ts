import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { prisma } from "@/lib/db/client"

const TOPUP_MINIMUM = TOPUP_MINIMUM_IDR
const WELCOME_BONUS_AMOUNT = 5000

export async function GET() {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: {
        id: true,
        email: true,
        name: true,
        balance: true,
        welcomeBonusGrantedAt: true,
        createdAt: true,
        topUpOrders: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        billingTransactions: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    })

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      balance: user.balance,
      welcomeBonusGrantedAt: user.welcomeBonusGrantedAt,
      welcomeBonusAmount: WELCOME_BONUS_AMOUNT,
      topupMinimum: TOPUP_MINIMUM,
      topUpOrders: user.topUpOrders.map((order) => ({
        id: order.id,
        reference: order.reference,
        amount: order.amount,
        status: order.status,
        provider: order.provider,
        providerReference: order.providerReference,
        checkoutUrl: order.checkoutUrl,
        paymentCode: order.paymentCode,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        payload: order.payload,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        expiresAt: order.expiresAt,
      })),
      billingTransactions: user.billingTransactions.map((transaction) => ({
        id: transaction.id,
        kind: transaction.kind,
        direction: transaction.direction,
        amount: transaction.amount,
        balanceBefore: transaction.balanceBefore,
        balanceAfter: transaction.balanceAfter,
        reference: transaction.reference,
        provider: transaction.provider,
        providerReference: transaction.providerReference,
        description: transaction.description,
        createdAt: transaction.createdAt,
      })),
    })
  } catch (error) {
    console.error("[billing] Failed to load billing overview", error)
    return NextResponse.json({ error: "Failed to load billing overview" }, { status: 500 })
  }
}