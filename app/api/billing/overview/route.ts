import { NextResponse } from "next/server"
import { getSession } from "@/auth"
import { SIGNUP_CREDITS_AMOUNT, TOPUP_MINIMUM_IDR } from "@/lib/billing/constants"
import { db } from "@/lib/db/client"
import { users, topUpOrders, billingTransactions } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"

const TOPUP_MINIMUM = TOPUP_MINIMUM_IDR
const WELCOME_BONUS_AMOUNT = SIGNUP_CREDITS_AMOUNT

export async function GET() {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, session.email),
      with: {
        topUpOrders: {
          orderBy: desc(topUpOrders.createdAt),
          limit: 10,
        },
        billingTransactions: {
          orderBy: desc(billingTransactions.createdAt),
          limit: 10,
        },
      },
    }) as {
      balance: number
      welcomeBonusGrantedAt: Date | null
      topUpOrders: Array<{
        id: string
        reference: string
        amount: number
        status: string
        provider: string
        providerReference: string | null
        checkoutUrl: string | null
        paymentCode: string | null
        customerName: string | null
        customerEmail: string | null
        payload: string | null
        createdAt: Date
        paidAt: Date | null
        expiresAt: Date | null
      }>
      billingTransactions: Array<{
        id: string
        kind: string
        direction: string
        amount: number
        balanceBefore: number | null
        balanceAfter: number | null
        reference: string | null
        provider: string | null
        providerReference: string | null
        description: string | null
        createdAt: Date
      }>
    } | undefined

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
