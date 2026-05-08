import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"

export function normalizeAdminEmail(email: string) {
  return email.trim().toLowerCase()
}

export async function getCurrentDeveloperActor() {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return null
  }

  const sessionEmail = normalizeAdminEmail(email)
  if (sessionEmail !== normalizeAdminEmail(env.devOwnerEmail)) {
    return null
  }

  return prisma.user.findFirst({
    where: {
      email: sessionEmail,
      isDeveloperAccount: true,
    },
    select: {
      id: true,
      email: true,
      balance: true,
      isDeveloperAccount: true,
    },
  })
}

export async function requireDeveloperActorResponse() {
  const actor = await getCurrentDeveloperActor()

  if (!actor) {
    const session = await auth()
    return {
      error: NextResponse.json(
        { error: session?.user?.email ? "Developer access required" : "Unauthorized" },
        { status: session?.user?.email ? 403 : 401 }
      ),
    }
  }

  return { actor }
}
