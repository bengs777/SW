import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { projects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import dns from "dns"
import { assertFeatureEnabled } from "@/lib/feature-flags"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"
import { getProjectAccess } from "@/lib/auth/project-access"

export const runtime = "nodejs"

async function assertProjectAccess(
  projectId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const access = await getProjectAccess(projectId, { userId })
  if (access) return { ok: true }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { id: true },
  })
  return { ok: false, status: project ? 403 : 404 }
}

async function guardProject(
  projectId: string,
  userId: string
): Promise<NextResponse | null> {
  const result = await assertProjectAccess(projectId, userId)
  if (result.ok) return null
  return NextResponse.json(
    { error: result.status === 403 ? "Forbidden" : "Project not found" },
    { status: result.status }
  )
}

function isValidDomain(domain: string) {
  // Basic domain validation (allows subdomains)
  const re = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/
  return re.test(domain)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableCustomDomain", "Custom domain")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { id } = await params
    const denied = await guardProject(id, session.userId)
    if (denied) return denied

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    return NextResponse.json({ success: true, project })
  } catch (err) {
    console.error("[v0] Error fetching project domain:", err)
    return NextResponse.json({ error: "Failed to fetch project domain" }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableCustomDomain", "Custom domain")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await enforceRouteRateLimit(`project-domain:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const domainRaw = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : ""

    const denied = await guardProject(id, session.userId)
    if (denied) return denied

    if (!domainRaw) {
      return NextResponse.json({ error: "Missing domain" }, { status: 400 })
    }

    if (!isValidDomain(domainRaw)) {
      return NextResponse.json({ error: "Invalid domain format" }, { status: 400 })
    }

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const updated = await db.update(projects)
      .set({
        customDomain: domainRaw,
        domainVerified: false,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning()

    // Provide DNS instructions (Vercel-style)
    const parts = domainRaw.split('.')
    const isApex = parts.length <= 2

    const instructions = isApex
      ? {
          type: 'apex',
          note: 'Add A records for your apex domain pointing to Vercel',
          records: [
            { type: 'A', name: '@', value: '76.76.21.21' },
          ],
        }
      : {
          type: 'subdomain',
          note: 'Add a CNAME record from your subdomain to cname.vercel-dns.com',
          records: [
            { type: 'CNAME', name: domainRaw.split('.').slice(0, 1).join('.'), value: 'cname.vercel-dns.com' },
          ],
        }

    return NextResponse.json({ success: true, project: updated[0], instructions })
  } catch (err) {
    console.error('[v0] Error saving domain:', err)
    return NextResponse.json({ error: 'Failed to save domain' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const featureCheck = assertFeatureEnabled("enableCustomDomain", "Custom domain")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    await enforceRouteRateLimit(`project-domain-verify:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const domainFromBody = typeof body?.domain === 'string' ? body.domain.trim().toLowerCase() : null

    const denied = await guardProject(id, session.userId)
    if (denied) return denied

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, id),
    })

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const domain = domainFromBody || project.customDomain
    if (!domain) return NextResponse.json({ error: 'No domain configured' }, { status: 400 })

    if (!isValidDomain(domain)) return NextResponse.json({ error: 'Invalid domain' }, { status: 400 })

    const parts = domain.split('.')
    const isApex = parts.length <= 2

    const resolver = dns.promises

    let verified = false
    const details: {
      a: string[] | { error: string } | null
      cname: string[] | { error: string } | null
    } = { a: null, cname: null }

    if (isApex) {
      try {
        const aRecords = await resolver.resolve4(domain)
        details.a = aRecords
        if (aRecords && aRecords.includes('76.76.21.21')) {
          verified = true
        }
      } catch (e) {
        details.a = { error: String(e) }
      }
    } else {
      try {
        const cname = await resolver.resolveCname(domain)
        details.cname = cname
        if (Array.isArray(cname) && cname.some((c) => String(c).includes('vercel'))) {
          verified = true
        }
      } catch (e) {
        details.cname = { error: String(e) }
        try {
          const aRecords = await resolver.resolve4(domain)
          details.a = aRecords
          if (aRecords && aRecords.includes('76.76.21.21')) verified = true
        } catch (e2) {
          details.a = { error: String(e2) }
        }
      }
    }

    if (verified) {
      await db.update(projects).set({ domainVerified: true, updatedAt: new Date() }).where(eq(projects.id, id))
    }

    return NextResponse.json({ success: true, verified, details })
  } catch (err) {
    console.error('[v0] Error verifying domain:', err)
    return NextResponse.json({ error: 'Failed to verify domain' }, { status: 500 })
  }
}
