import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/db/client'
import { WorkspaceService } from '@/lib/services/workspace.service'
import { ApiKeyService } from '@/lib/services/api-key.service'

const ApiKeyActionSchema = z.object({
  action: z.literal('rotate'),
})

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteContext
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id: apiKeyId } = await params

    // Get the API key to find workspace
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: apiKeyId },
    })

    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }

    // Check if user is admin of workspace
    const membership = await WorkspaceService.checkMembership(
      apiKey.workspaceId,
      session.user.id
    )

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only admins can delete API keys' },
        { status: 403 }
      )
    }

    await ApiKeyService.deleteApiKey(apiKeyId)
    return NextResponse.json({ message: 'API key deleted' })
  } catch (error) {
    console.error('[v0] Error deleting API key:', error)
    return NextResponse.json(
      { error: 'Failed to delete API key' },
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
    const { id: apiKeyId } = await params
    const { action } = ApiKeyActionSchema.parse(await request.json())

    if (action === 'rotate') {
      // Get the API key to find workspace
      const apiKey = await prisma.apiKey.findUnique({
        where: { id: apiKeyId },
      })

      if (!apiKey) {
        return NextResponse.json(
          { error: 'API key not found' },
          { status: 404 }
        )
      }

      // Check if user is admin of workspace
      const membership = await WorkspaceService.checkMembership(
        apiKey.workspaceId,
        session.user.id
      )

      if (!membership || membership.role !== 'admin') {
        return NextResponse.json(
          { error: 'Only admins can rotate API keys' },
          { status: 403 }
        )
      }

      const newApiKey = await ApiKeyService.rotateApiKey(apiKeyId)
      return NextResponse.json(newApiKey)
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    console.error('[v0] Error rotating API key:', error)
    return NextResponse.json(
      { error: 'Failed to rotate API key' },
      { status: 500 }
    )
  }
}
