import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { getTemplateById } from "@/lib/templates/catalog"
import type { Template } from "@/lib/types"

type TemplateWorkspace = {
  id: string
  name: string
  slug: string
}

export type TemplateInstantiationResult = {
  project: {
    id: string
    workspaceId: string
    name: string
    description: string | null
    prompt: string | null
    templateId: string | null
    createdAt: Date
    updatedAt: Date
  }
  workspace: TemplateWorkspace
  template: Template
  createdWorkspace: boolean
}

export type TemplateInstantiationInput = {
  userId: string
  templateId: string
  workspaceId?: string | null
  projectName?: string | null
  description?: string | null
}

type TemplateUser = {
  id: string
  email: string
  name: string | null
}

const normalizeText = (value?: string | null) => value?.trim() || ""

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace"

async function createUniqueWorkspaceSlug(tx: Prisma.TransactionClient, baseSlug: string) {
  let candidate = baseSlug || "workspace"
  let suffix = 1

  while (await tx.workspace.findUnique({ where: { slug: candidate } })) {
    candidate = `${baseSlug || "workspace"}-${suffix}`
    suffix += 1
  }

  return candidate
}

async function resolveWorkspace(
  tx: Prisma.TransactionClient,
  user: TemplateUser,
  workspaceId?: string | null
) {
  if (workspaceId) {
    const membership = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: user.id,
        },
      },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    })

    if (!membership) {
      throw new Error("WORKSPACE_FORBIDDEN")
    }

    return { workspace: membership.workspace, createdWorkspace: false }
  }

  const memberships = await tx.workspaceMember.findMany({
    where: { userId: user.id },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: {
      joinedAt: "asc",
    },
  })

  if (memberships.length > 0) {
    return { workspace: memberships[0].workspace, createdWorkspace: false }
  }

  const workspaceBaseName = `${normalizeText(user.name) || user.email.split("@")[0]} Workspace`
  const workspaceSlug = await createUniqueWorkspaceSlug(tx, slugify(workspaceBaseName))

  const workspace = await tx.workspace.create({
    data: {
      name: workspaceBaseName,
      slug: workspaceSlug,
      createdBy: user.id,
    },
  })

  await tx.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "admin",
    },
  })

  await tx.subscription.create({
    data: {
      workspaceId: workspace.id,
      plan: "free",
    },
  })

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },
    createdWorkspace: true,
  }
}

export class TemplateInstantiationService {
  static async instantiateTemplate(input: TemplateInstantiationInput): Promise<TemplateInstantiationResult> {
    const template = getTemplateById(input.templateId)

    if (!template) {
      throw new Error("TEMPLATE_NOT_FOUND")
    }

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          email: true,
          name: true,
        },
      })

      if (!user) {
        throw new Error("USER_NOT_FOUND")
      }

      const { workspace, createdWorkspace } = await resolveWorkspace(tx, user, input.workspaceId)
      const projectName = normalizeText(input.projectName) || template.name
      const projectDescription = normalizeText(input.description) || template.description

      const project = await tx.project.create({
        data: {
          workspaceId: workspace.id,
          name: projectName,
          description: projectDescription,
          prompt: `[template:${template.id}] ${template.prompt}`,
          templateId: template.id,
        },
      })

      if (template.files.length > 0) {
        await tx.projectFile.createMany({
          data: template.files.map((file) => ({
            projectId: project.id,
            path: file.path,
            content: file.content,
            language: file.language,
          })),
        })
      }

      await tx.generationHistory.create({
        data: {
          projectId: project.id,
          prompt: `Template starter: ${template.name}`,
          result: JSON.stringify({
            templateId: template.id,
            templateName: template.name,
            files: template.files,
          }),
          tokensUsed: 0,
          idempotencyKey: `template:${template.id}:${project.id}`,
        },
      })

      return {
        project: {
          id: project.id,
          workspaceId: project.workspaceId,
          name: project.name,
          description: project.description,
          prompt: project.prompt,
          templateId: project.templateId,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
        workspace,
        template,
        createdWorkspace,
      }
    })
  }
}