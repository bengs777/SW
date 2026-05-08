import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/db/client'
import { WorkspaceService } from '@/lib/services/workspace.service'

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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: workspaceId } = await params

    // Check if user is member of workspace
    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.user.id
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
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: workspaceId } = await params
    const { email, role } = AddMemberSchema.parse(await request.json())

    // Check if user is admin of workspace
    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.user.id
    )

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only admins can add members' },
        { status: 403 }
      )
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
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
