import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { projects, projectFiles, workspaces, workspaceMembers } from "@/lib/db/schema"
import { eq, and, desc } from "drizzle-orm"
import { UserService } from "@/lib/services/user.service"
import { enforceRouteRateLimit } from "@/lib/security/rate-limit"

const CreateProjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  prompt: z.string().trim().max(12000).optional().nullable(),
  templateId: z.string().trim().min(1).max(120).optional().nullable(),
})

/**
 * Resolves a workspace id only when the user has access to it.
 * Also accepts a WorkspaceMember id to tolerate stale clients that used
 * the raw /api/workspaces membership response as a workspace option.
 */
async function resolveAccessibleWorkspaceId(workspaceId: string, userId: string): Promise<string | null> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  })

  if (membership) return workspaceId

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  })

  if (workspace?.createdBy === userId) {
    await db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role: "admin",
    }).onConflictDoNothing().catch(() => null)
    return workspaceId
  }

  const membershipAlias = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.id, workspaceId),
  })

  if (membershipAlias?.userId === userId) {
    return membershipAlias.workspaceId
  }

  const userWorkspaces = await db.select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))

  if (userWorkspaces.some((w) => w.workspaceId === workspaceId)) {
    return workspaceId
  }

  if (userWorkspaces.length === 0 && workspace) {
    await db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role: "admin",
    }).onConflictDoNothing().catch(() => null)
    return workspaceId
  }

  return null
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.email,
      session.name ?? null,
      session.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const workspaceId = request.nextUrl.searchParams.get("workspaceId")

    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      )
    }

    const userId = session.userId || user.id
    const resolvedWorkspaceId = await resolveAccessibleWorkspaceId(workspaceId, userId)

    if (!resolvedWorkspaceId) {
      const allMemberships = await db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .catch(() => [])
      const workspaceInfo = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      }).catch(() => null)
      console.error("[projects:GET] 403 Debug", {
        userId,
        userServiceId: user.id,
        sessionUserId: session.userId,
        workspaceId,
        email: session.email,
        workspaceCreatedBy: workspaceInfo?.createdBy,
        workspaceName: workspaceInfo?.name,
        userMemberships: allMemberships,
      })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const projectsData = await db.query.projects.findMany({
      where: eq(projects.workspaceId, resolvedWorkspaceId),
      with: {
        files: { limit: 5 },
      },
      orderBy: desc(projects.updatedAt),
    })

      return NextResponse.json({ projects: projectsData }, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    console.error("[projects:GET] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceRouteRateLimit(`projects-create:${session.email}`, { maxPerMinute: 20, maxPerHour: 200 })
  } catch {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.email,
      session.name ?? null,
      session.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { name, description, workspaceId, prompt, templateId } = CreateProjectSchema.parse(await request.json())

    const userId = session.userId || user.id
    const resolvedWorkspaceId = await resolveAccessibleWorkspaceId(workspaceId, userId)

    if (!resolvedWorkspaceId) {
      console.error("[projects:POST] 403 Debug", { userId, userServiceId: user.id, workspaceId, email: session.email })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const project = await db.insert(projects).values({
      id: crypto.randomUUID(),
      name,
      description,
      prompt,
      templateId,
      workspaceId: resolvedWorkspaceId,
    }).returning()

    revalidatePath("/dashboard")
    revalidatePath("/dashboard/projects")
    revalidatePath(`/dashboard/workspace/${resolvedWorkspaceId}`)

    return NextResponse.json({ project: project[0] }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid project request" },
        { status: 400 }
      )
    }

    console.error("[projects:POST] Error:", error)
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    )
  }
}
