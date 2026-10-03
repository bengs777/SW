import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/auth'
import { db } from '@/lib/db/client'
import { apiKeys } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { WorkspaceService } from '@/lib/services/workspace.service'
import { ApiKeyService } from '@/lib/services/api-key.service'
import { enforceRouteRateLimit } from '@/lib/security/rate-limit'

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
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`api-key-delete:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const { id: apiKeyId } = await params

    const apiKey = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, apiKeyId),
    })

    if (!apiKey) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 })
    }

    const membership = await WorkspaceService.checkMembership(
      apiKey.workspaceId,
      session.userId
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
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`api-key-rotate:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const { id: apiKeyId } = await params
    const { action } = ApiKeyActionSchema.parse(await request.json())

    if (action === 'rotate') {
      const apiKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, apiKeyId),
      })

      if (!apiKey) {
        return NextResponse.json(
          { error: 'API key not found' },
          { status: 404 }
        )
      }

      const membership = await WorkspaceService.checkMembership(
        apiKey.workspaceId,
        session.userId
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
