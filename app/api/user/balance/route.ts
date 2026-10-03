import { NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { SWIFT_PUBLIC_PRICE_IDR } from "@/lib/ai/model-tiers"

export async function GET() {
  const session = await getSession()

  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, session.email),
    })

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      userId: user.id,
      balance: user.balance,
      email: user.email,
      costPerGeneration: SWIFT_PUBLIC_PRICE_IDR,
      generationsAvailable: Math.floor(user.balance / SWIFT_PUBLIC_PRICE_IDR),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch balance"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
