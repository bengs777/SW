import { db } from '@/lib/db/client'
import { workspaces, workspaceMembers, subscriptions, users } from '@/lib/db/schema'
import { eq, and, asc } from 'drizzle-orm'

export class WorkspaceService {
  static async createWorkspace(
    name: string,
    slug: string,
    createdBy: string
  ) {
    const workspace = await db.insert(workspaces).values({
      id: crypto.randomUUID(),
      name,
      slug,
      createdBy,
    }).returning()

    await db.insert(workspaceMembers).values({
          id: crypto.randomUUID(),
      workspaceId: workspace[0].id,
      userId: createdBy,
      role: 'admin',
    })

    await db.insert(subscriptions).values({
          id: crypto.randomUUID(),
      workspaceId: workspace[0].id,
      plan: 'free',
    })

    return workspace[0]
  }

  static async getWorkspaceWithMembers(workspaceId: string) {
    const workspace = await db.select().from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (workspace.length === 0) return null

    const members = await db.select().from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    const memberUsers = await Promise.all(
      members.map(async (member) => {
        const user = await db.select({
          id: users.id,
          email: users.email,
          name: users.name,
          image: users.image,
        }).from(users)
          .where(eq(users.id, member.userId))
          .limit(1)
        return { ...member, user: user[0] }
      })
    )

    const subscription = await db.select().from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1)

    const creator = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
    }).from(users)
      .where(eq(users.id, workspace[0].createdBy))
      .limit(1)

    return {
      ...workspace[0],
      members: memberUsers,
      subscription: subscription[0] || null,
      creator: creator[0] || null,
    }
  }

  static async addMember(
    workspaceId: string,
    userId: string,
    role: string = 'member'
  ) {
    const result = await db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role,
    }).returning()

    const user = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
    }).from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return { ...result[0], user: user[0] }
  }

  static async removeMember(workspaceId: string, userId: string) {
    return db.delete(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
      .returning()
  }

  static async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: string
  ) {
    const result = await db.update(workspaceMembers)
      .set({ role })
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
      .returning()

    const user = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
    }).from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return { ...result[0], user: user[0] }
  }

  static async getUserWorkspaces(userId: string) {
    const memberships = await db.select().from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaceMembers.joinedAt))

    return Promise.all(
      memberships.map(async (membership) => {
        const workspace = await db.select().from(workspaces)
          .where(eq(workspaces.id, membership.workspaceId))
          .limit(1)

        const subscription = await db.select().from(subscriptions)
          .where(eq(subscriptions.workspaceId, membership.workspaceId))
          .limit(1)

        return {
          ...membership,
          workspace: {
            ...workspace[0],
            subscription: subscription[0] || null,
          },
        }
      })
    )
  }

  static async checkMembership(workspaceId: string, userId: string) {
    const result = await db.select().from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ))
      .limit(1)

    return result[0] || null
  }

  static async deleteWorkspace(workspaceId: string) {
    return db.delete(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .returning()
  }

  static async updateWorkspace(
    workspaceId: string,
    data: { name?: string; image?: string }
  ) {
    const result = await db.update(workspaces)
      .set(data)
      .where(eq(workspaces.id, workspaceId))
      .returning()

    const members = await db.select().from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    const memberUsers = await Promise.all(
      members.map(async (member) => {
        const user = await db.select().from(users)
          .where(eq(users.id, member.userId))
          .limit(1)
        return { ...member, user: user[0] }
      })
    )

    return { ...result[0], members: memberUsers }
  }
}
