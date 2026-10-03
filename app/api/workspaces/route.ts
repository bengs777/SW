import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/auth'
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from '@/lib/db/errors'
import { db } from '@/lib/db/client'
import { workspaces } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { WorkspaceService } from '@/lib/services/workspace.service'
import { assertFeatureEnabled } from '@/lib/feature-flags'
import { enforceRouteRateLimit } from '@/lib/security/rate-limit'

const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must use lowercase letters, numbers, and hyphens'),
})

export async function GET() {
  try {
    const featureCheck = assertFeatureEnabled("enableTeams", "Teams")
    if (featureCheck) {
      return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
    }

    const session = await getSession()

    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const workspaces = await WorkspaceService.getUserWorkspaces(session.userId)
    return NextResponse.json(workspaces)
  } catch (error) {
    if (isMissingRequiredTableError(error) && shouldSoftFailMissingTable()) {
      console.warn('[v0] Required database tables are not ready yet; returning empty workspaces list.')

      return NextResponse.json([])
    }

    console.error('[v0] Error fetching workspaces:', error)
    return NextResponse.json(
      { error: 'Failed to fetch workspaces' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const featureCheck = assertFeatureEnabled("enableTeams", "Teams")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`workspaces-create:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const { name, slug } = CreateWorkspaceSchema.parse(await request.json())

    const existingWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, slug),
    })

    if (existingWorkspace) {
      return NextResponse.json(
        { error: 'Workspace slug already exists' },
        { status: 400 }
      )
    }

    const workspace = await WorkspaceService.createWorkspace(
      name,
      slug,
      session.userId
    )

    return NextResponse.json(workspace, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || 'Invalid workspace request' },
        { status: 400 }
      )
    }

    console.error('[v0] Error creating workspace:', error)
    return NextResponse.json(
      { error: 'Failed to create workspace' },
      { status: 500 }
    )
  }
}
