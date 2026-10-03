import { WebhookEvent } from '@clerk/nextjs/server'
import { Webhook } from 'svix'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { users, workspaces, workspaceMembers, subscriptions, billingTransactions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'

const webhookSecret = env.clerkSecretKey

async function ensureUserExists(email: string, name: string | null, image: string | null) {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
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
    email,
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
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
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
  } catch (err) {
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
        const id = data.id
        if (id) {
          await db.delete(users).where(eq(users.id, id))
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
