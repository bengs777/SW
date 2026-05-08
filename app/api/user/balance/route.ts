import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"

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
        balance: true,
        email: true,
      },
    })

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      userId: user.id,
      balance: user.balance,
      email: user.email,
      costPerGeneration: 2000,
      generationsAvailable: Math.floor(user.balance / 2000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch balance"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
