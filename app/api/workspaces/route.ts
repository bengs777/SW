import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { isMissingRequiredTableError, shouldSoftFailMissingTable } from '@/lib/db/errors'
import { prisma } from '@/lib/db/client'
import { WorkspaceService } from '@/lib/services/workspace.service'

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
    const session = await auth()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const workspaces = await WorkspaceService.getUserWorkspaces(session.user.id)
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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { name, slug } = CreateWorkspaceSchema.parse(await request.json())

    // Check if slug already exists
    const existingWorkspace = await prisma.workspace.findUnique({
      where: { slug },
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
      session.user.id
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
