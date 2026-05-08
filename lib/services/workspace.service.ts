import { prisma } from '@/lib/db/client'

export class WorkspaceService {
  static async createWorkspace(
    name: string,
    slug: string,
    createdBy: string
  ) {
    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug,
        createdBy,
      },
    })

    // Add creator as admin
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: createdBy,
        role: 'admin',
      },
    })

    // Create subscription
    await prisma.subscription.create({
      data: {
        workspaceId: workspace.id,
        plan: 'free',
      },
    })

    return workspace
  }

  static async getWorkspaceWithMembers(workspaceId: string) {
    return prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                image: true,
              },
            },
          },
        },
        subscription: true,
        creator: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })
  }

  static async addMember(
    workspaceId: string,
    userId: string,
    role: string = 'member'
  ) {
    return prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
          },
        },
      },
    })
  }

  static async removeMember(workspaceId: string, userId: string) {
    return prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    })
  }

  static async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: string
  ) {
    return prisma.workspaceMember.update({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      data: { role },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
          },
        },
      },
    })
  }

  static async getUserWorkspaces(userId: string) {
    return prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            subscription: true,
          },
        },
      },
    })
  }

  static async checkMembership(workspaceId: string, userId: string) {
    return prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    })
  }

  static async deleteWorkspace(workspaceId: string) {
    return prisma.workspace.delete({
      where: { id: workspaceId },
    })
  }

  static async updateWorkspace(
    workspaceId: string,
    data: { name?: string; image?: string }
  ) {
    return prisma.workspace.update({
      where: { id: workspaceId },
      data,
      include: {
        members: {
          include: {
            user: true,
          },
        },
      },
    })
  }
}
