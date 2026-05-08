import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import dns from "dns"

export const runtime = "nodejs"

function isValidDomain(domain: string) {
  // Basic domain validation (allows subdomains)
  const re = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/
  return re.test(domain)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { id } = await params
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: {
          members: {
            some: { userId: session.user.id },
          },
        },
      },
      select: {
        id: true,
        name: true,
        customDomain: true,
        domainVerified: true,
      },
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
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const domainRaw = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : ""

    if (!domainRaw) {
      return NextResponse.json({ error: "Missing domain" }, { status: 400 })
    }

    if (!isValidDomain(domainRaw)) {
      return NextResponse.json({ error: "Invalid domain format" }, { status: 400 })
    }

    // Check permissions
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspace: { members: { some: { userId: session.user.id } } },
      },
    })

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const updated = await prisma.project.update({
      where: { id },
      data: {
        customDomain: domainRaw,
        domainVerified: false,
      },
      select: { id: true, customDomain: true, domainVerified: true },
    })

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

    return NextResponse.json({ success: true, project: updated, instructions })
  } catch (err) {
    console.error('[v0] Error saving domain:', err)
    return NextResponse.json({ error: 'Failed to save domain' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // POST will be used to verify DNS propagation for the saved domain
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const domainFromBody = typeof body?.domain === 'string' ? body.domain.trim().toLowerCase() : null

    const project = await prisma.project.findFirst({
      where: { id, workspace: { members: { some: { userId: session.user.id } } } },
      select: { id: true, customDomain: true },
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
        // Some providers don't return CNAME; try A records as fallback
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
      await prisma.project.update({ where: { id }, data: { domainVerified: true } })
    }

    return NextResponse.json({ success: true, verified, details })
  } catch (err) {
    console.error('[v0] Error verifying domain:', err)
    return NextResponse.json({ error: 'Failed to verify domain' }, { status: 500 })
  }
}
