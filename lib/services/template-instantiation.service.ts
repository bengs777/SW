import { db } from "@/lib/db/client"
import { workspaces, workspaceMembers, subscriptions, projects, projectFiles, generationHistory, users } from "@/lib/db/schema"
import { eq, and, asc } from "drizzle-orm"
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

async function createUniqueWorkspaceSlug(baseSlug: string) {
  let candidate = baseSlug || "workspace"
  let suffix = 1

  while (true) {
    const existing = await db.select().from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1)

    if (existing.length === 0) break

    candidate = `${baseSlug || "workspace"}-${suffix}`
    suffix += 1
  }

  return candidate
}

async function resolveWorkspace(
  user: TemplateUser,
  workspaceId?: string | null
) {
  if (workspaceId) {
    const membershipResult = await db.select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    }).from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, user.id)
      ))
      .limit(1)

    if (membershipResult.length === 0) {
      throw new Error("WORKSPACE_FORBIDDEN")
    }

    const workspaceResult = await db.select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
    }).from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    return { workspace: workspaceResult[0], createdWorkspace: false }
  }

  const membershipsResult = await db.select({
    id: workspaceMembers.id,
    workspaceId: workspaceMembers.workspaceId,
    userId: workspaceMembers.userId,
    role: workspaceMembers.role,
    joinedAt: workspaceMembers.joinedAt,
  }).from(workspaceMembers)
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(asc(workspaceMembers.joinedAt))

  if (membershipsResult.length > 0) {
    const workspaceResult = await db.select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
    }).from(workspaces)
      .where(eq(workspaces.id, membershipsResult[0].workspaceId))
      .limit(1)

    return { workspace: workspaceResult[0], createdWorkspace: false }
  }

  const workspaceBaseName = `${normalizeText(user.name) || user.email.split("@")[0]} Workspace`
  const workspaceSlug = await createUniqueWorkspaceSlug(slugify(workspaceBaseName))

  const workspaceResult = await db.insert(workspaces).values({
    id: crypto.randomUUID(),
    name: workspaceBaseName,
    slug: workspaceSlug,
    createdBy: user.id,
  }).returning()

  const workspace = workspaceResult[0]

  await db.insert(workspaceMembers).values({
          id: crypto.randomUUID(),
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
  })

  await db.insert(subscriptions).values({
          id: crypto.randomUUID(),
    workspaceId: workspace.id,
    plan: "free",
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

    return db.transaction(async (tx) => {
      const userResult = await tx.select({
        id: users.id,
        email: users.email,
        name: users.name,
      }).from(users)
        .where(eq(users.id, input.userId))
        .limit(1)

      const user = userResult[0]

      if (!user) {
        throw new Error("USER_NOT_FOUND")
      }

      const { workspace, createdWorkspace } = await resolveWorkspace(user, input.workspaceId)
      const projectName = normalizeText(input.projectName) || template.name
      const projectDescription = normalizeText(input.description) || template.description

      const projectResult = await tx.insert(projects).values({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        name: projectName,
        description: projectDescription,
        prompt: `[template:${template.id}] ${template.prompt}`,
        templateId: template.id,
      }).returning()

      const project = projectResult[0]

      if (template.files.length > 0) {
        await tx.insert(projectFiles).values(
          template.files.map((file) => ({
            id: crypto.randomUUID(),
            projectId: project.id,
            path: file.path,
            content: file.content,
            language: file.language,
          }))
        )
      }

      await tx.insert(generationHistory).values({
          id: crypto.randomUUID(),
        projectId: project.id,
        prompt: `Template starter: ${template.name}`,
        result: JSON.stringify({
          templateId: template.id,
          templateName: template.name,
          files: template.files,
        }),
        tokensUsed: 0,
        idempotencyKey: `template:${template.id}:${project.id}`,
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
