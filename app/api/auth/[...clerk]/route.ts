import { WebhookEvent } from '@clerk/nextjs/server'
import { Webhook } from 'svix'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { users, workspaces, workspaceMembers, subscriptions, billingTransactions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'

const webhookSecret = env.clerkWebhookSecret

async function ensureUserExists(email: string, name: string | null, image: string | null) {
  const normalizedEmail = email.trim().toLowerCase()
  const existing = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  })

  if (existing) {
    await db.update(users)
      .set({ name, image, updatedAt: new Date() })
      .where(eq(users.id, existing.id))
    return existing.id
  }

  const userId = crypto.randomUUID()
  const workspaceId = crypto.randomUUID()
  const workspaceSlug = `workspace-${crypto.randomUUID().slice(0, 8)}`

  await db.insert(users).values({
    id: userId,
    email: normalizedEmail,
    name,
    image,
    balance: 10000,
    isDeveloperAccount: false,
    welcomeBonusGrantedAt: new Date(),
  })

  await db.insert(workspaces).values({
    id: workspaceId,
    name: name ? `${name}'s Workspace` : 'My Workspace',
    slug: workspaceSlug,
    createdBy: userId,
  })

  await db.insert(workspaceMembers).values({
    id: crypto.randomUUID(),
    workspaceId,
    userId,
    role: 'admin',
  })

  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    workspaceId,
    plan: 'free',
    status: 'active',
    tokensLimit: 10000,
    tokensUsed: 0,
  })

  await db.insert(billingTransactions).values({
    id: crypto.randomUUID(),
    userId,
    kind: 'welcome_bonus',
    direction: 'credit',
    amount: 10000,
    balanceBefore: 0,
    balanceAfter: 10000,
    reference: `welcome-${userId}`,
    description: 'Welcome bonus',
  })

  return userId
}

export async function POST(req: Request) {
  if (!webhookSecret) {
    return NextResponse.json(
      { error: 'CLERK_WEBHOOK_SECRET is not configured' },
      { status: 503 }
    )
  }

  const svix_id = req.headers.get('svix-id')
  const svix_timestamp = req.headers.get('svix-timestamp')
  const svix_signature = req.headers.get('svix-signature')

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return NextResponse.json({ error: 'Missing svix headers' }, { status: 400 })
  }

  const body = await req.text()
  const wh = new Webhook(webhookSecret)

  let evt: WebhookEvent | undefined
  try {
    evt = wh.verify(body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent | undefined
  } catch (error) {
    console.warn('[clerk-webhook] signature verification failed:', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 400 })
  }

  if (!evt) {
    return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 })
  }

  const { type, data } = evt

  try {
    switch (type) {
      case 'user.created':
      case 'user.updated': {
        const email = data.email_addresses?.[0]?.email_address
        if (email) {
          const name = data.first_name && data.last_name
            ? `${data.first_name} ${data.last_name}`
            : data.first_name || data.last_name || null
          const image = data.image_url || null
          await ensureUserExists(email, name, image)
        }
        break
      }
      case 'user.deleted': {
        const payload = data as {
          id?: string
          email_address?: string
          email_addresses?: Array<{ email_address?: string }>
        }
        const email =
          payload.email_addresses?.[0]?.email_address || payload.email_address || null

        if (email) {
          await db.delete(users).where(eq(users.email, email.trim().toLowerCase()))
        } else {
          console.warn('[clerk-webhook] user.deleted ignored: no resolvable email', {
            clerkUserId: payload.id,
          })
        }
        break
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Webhook processing failed' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
