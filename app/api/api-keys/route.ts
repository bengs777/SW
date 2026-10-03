import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/auth'
import { WorkspaceService } from '@/lib/services/workspace.service'
import { ApiKeyService } from '@/lib/services/api-key.service'
import { enforceRouteRateLimit } from '@/lib/security/rate-limit'

const CreateApiKeySchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
})

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const workspaceId = request.nextUrl.searchParams.get('workspaceId')

    if (!workspaceId) {
      return NextResponse.json(
        { error: 'workspaceId is required' },
        { status: 400 }
      )
    }

    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.userId
    )

    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const apiKeys = await ApiKeyService.getApiKeys(workspaceId)
    return NextResponse.json(apiKeys)
  } catch (error) {
    console.error('[v0] Error fetching API keys:', error)
    return NextResponse.json(
      { error: 'Failed to fetch API keys' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`api-key-create:${session.userId}`, { maxPerMinute: 10, maxPerHour: 60 })
  } catch {
    return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  try {
    const { workspaceId, name } = CreateApiKeySchema.parse(await request.json())

    const membership = await WorkspaceService.checkMembership(
      workspaceId,
      session.userId
    )

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json(
        { error: 'Only admins can create API keys' },
        { status: 403 }
      )
    }

    const apiKey = await ApiKeyService.createApiKey(workspaceId, name)
    return NextResponse.json(apiKey, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || 'Invalid API key request' },
        { status: 400 }
      )
    }

    console.error('[v0] Error creating API key:', error)
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    )
  }
}
