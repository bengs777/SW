import { db } from "@/lib/db/client"
import { projects, users, workspaceMembers } from "@/lib/db/schema"
import { and, eq, inArray } from "drizzle-orm"

export type ProjectAccessRef = {
  userId?: string | null
  email?: string | null
}

export type ProjectAccess = {
  projectId: string
  workspaceId: string
  role: string
}

function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() || null
}

async function resolveCandidateUserIds(ref: ProjectAccessRef): Promise<string[]> {
  const ids = new Set<string>()

  if (ref.userId) ids.add(ref.userId)

  const email = normalizeEmail(ref.email)
  if (email) {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    })
    if (dbUser?.id) ids.add(dbUser.id)
  }

  return Array.from(ids)
}

/**
 * Returns the caller's workspace role for a project, or null when the caller
 * is not a member of the project's workspace.
 *
 * Every project access check in the API layer must go through this helper so
 * ownership scoping cannot be accidentally omitted again.
 */
export async function getProjectAccess(
  projectId: string,
  ref: ProjectAccessRef
): Promise<ProjectAccess | null> {
  if (!projectId) return null

  const candidateIds = await resolveCandidateUserIds(ref)
  if (candidateIds.length === 0) return null

  const rows = await db
    .select({
      projectId: projects.id,
      workspaceId: projects.workspaceId,
      role: workspaceMembers.role,
    })
    .from(projects)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, projects.workspaceId)
    )
    .where(and(eq(projects.id, projectId), inArray(workspaceMembers.userId, candidateIds)))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  return {
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    role: row.role,
  }
}

export async function hasProjectAccess(
  projectId: string,
  ref: ProjectAccessRef
): Promise<boolean> {
  return (await getProjectAccess(projectId, ref)) !== null
}
