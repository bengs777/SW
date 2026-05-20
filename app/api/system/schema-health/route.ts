import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { getDatabaseSchemaHealth } from "@/lib/db/schema-health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function requireSchemaHealthAccess() {
  if (process.env.NODE_ENV !== "production") return { ok: true, status: 200 }

  const session = await auth()
  const email = session?.user?.email
  if (!email) return { ok: false, status: 401 }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { isDeveloperAccount: true },
  })

  return { ok: Boolean(user?.isDeveloperAccount), status: user?.isDeveloperAccount ? 200 : 403 }
}

export async function GET() {
  const access = await requireSchemaHealthAccess()
  if (!access.ok) {
    return NextResponse.json({ error: "Not authorized" }, { status: access.status })
  }

  try {
    const health = await getDatabaseSchemaHealth()
    return NextResponse.json(health, {
      status: health.compatible ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        runtimeSchema: "20260520120000",
        databaseSchema: null,
        compatible: false,
        missingTables: [],
        missingColumns: [],
        probableRootCause: "database schema mismatch",
        error: error instanceof Error ? error.message : String(error),
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    )
  }
}
