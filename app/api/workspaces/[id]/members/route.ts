import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/auth'
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { WorkspaceService } from '@/lib/services/workspace.service'
import { enforceRouteRateLimit } from '@/lib/security/rate-limit'

const AddMemberSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['admin', 'editor', 'viewer', 'member']).optional().default('member'),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: workspaceId } = await params

    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.userId
    )

    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const workspace = await WorkspaceService.getWorkspaceWithMembers(
      workspaceId
    )

    return NextResponse.json(workspace?.members || [])
  } catch (error) {
    console.error('[v0] Error fetching members:', error)
    return NextResponse.json(
      { error: 'Failed to fetch members' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext
) {
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`workspace-member-add:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const { id: workspaceId } = await params
    const { email, role } = AddMemberSchema.parse(await request.json())

    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.userId
    )

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only admins can add members' },
        { status: 403 }
      )
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Check if already a member
    const existingMember = await WorkspaceService.checkMembership(
      workspaceId,
      user.id
    )

    if (existingMember) {
      return NextResponse.json(
        { error: 'User is already a member' },
        { status: 400 }
      )
    }

    const newMember = await WorkspaceService.addMember(
      workspaceId,
      user.id,
      role
    )

    return NextResponse.json(newMember, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || 'Invalid member request' },
        { status: 400 }
      )
    }

    console.error('[v0] Error adding member:', error)
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    )
  }
}
