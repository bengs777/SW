import { NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { users } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getDatabaseSchemaHealth } from "@/lib/db/schema-health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function requireSchemaHealthAccess() {
  if (process.env.NODE_ENV !== "production") return { ok: true, status: 200 }

  const session = await getSession()
  const email = session?.email
  if (!email) return { ok: false, status: 401 }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
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
