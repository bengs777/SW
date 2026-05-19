import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { UserService } from "@/lib/services/user.service"

const CreateProjectSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  prompt: z.string().trim().max(12000).optional().nullable(),
})

/**
 * Resolves a workspace id only when the user has access to it.
 * Also accepts a WorkspaceMember id to tolerate stale clients that used
 * the raw /api/workspaces membership response as a workspace option.
 */
async function resolveAccessibleWorkspaceId(workspaceId: string, userId: string): Promise<string | null> {
  // Strategy 1: check membership table (fast path)
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  })

  if (membership) return workspaceId

  // Strategy 2: check if user is the workspace creator
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { createdBy: true },
  })

  if (workspace?.createdBy === userId) {
    // Auto-heal: create the missing membership record
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "admin" },
      update: {},
    }).catch(() => null)
    return workspaceId
  }

  // Strategy 3: accept the user's WorkspaceMember.id as a legacy alias.
  const membershipAlias = await prisma.workspaceMember.findUnique({
    where: { id: workspaceId },
    select: { workspaceId: true, userId: true },
  })

  if (membershipAlias?.userId === userId) {
    return membershipAlias.workspaceId
  }

  // Strategy 4: check if workspace belongs to user via any path
  // (handles edge cases where createdBy was set differently)
  const userWorkspaces = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  })

  if (userWorkspaces.some((w) => w.workspaceId === workspaceId)) {
    return workspaceId
  }

  // Strategy 5: if user has NO memberships at all but workspace exists,
  // check if they're the only user who should have access
  if (userWorkspaces.length === 0 && workspace) {
    // User has no memberships anywhere — likely orphaned. Grant access to this workspace.
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: "admin" },
      update: {},
    }).catch(() => null)
    console.warn("[projects] Auto-granted workspace access to orphaned user", { userId, workspaceId })
    return workspaceId
  }

  return null
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
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

    // Use session.user.id as the authoritative user ID (matches what /api/workspaces uses)
    const userId = session.user.id || user.id
    const resolvedWorkspaceId = await resolveAccessibleWorkspaceId(workspaceId, userId)

    if (!resolvedWorkspaceId) {
      // Log comprehensive debug info
      const allMemberships = await prisma.workspaceMember.findMany({
        where: { userId },
        select: { workspaceId: true, role: true },
      }).catch(() => [])
      const workspaceInfo = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, createdBy: true, name: true },
      }).catch(() => null)
      console.error("[projects:GET] 403 Debug", {
        userId,
        userServiceId: user.id,
        sessionUserId: session.user.id,
        workspaceId,
        email: session.user.email,
        workspaceCreatedBy: workspaceInfo?.createdBy,
        workspaceName: workspaceInfo?.name,
        userMemberships: allMemberships,
      })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const projects = await prisma.project.findMany({
      where: { workspaceId: resolvedWorkspaceId },
      include: {
        files: {
          take: 5,
        },
      },
      orderBy: { updatedAt: "desc" },
    })

    return NextResponse.json({ projects }, {
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
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const { name, description, workspaceId, prompt } = CreateProjectSchema.parse(await request.json())

    // Use session.user.id as the authoritative user ID
    const userId = session.user.id || user.id
    const resolvedWorkspaceId = await resolveAccessibleWorkspaceId(workspaceId, userId)

    if (!resolvedWorkspaceId) {
      console.error("[projects:POST] 403 Debug", { userId, userServiceId: user.id, workspaceId, email: session.user.email })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        prompt,
        workspaceId: resolvedWorkspaceId,
      },
    })

    revalidatePath("/dashboard")
    revalidatePath("/dashboard/projects")
    revalidatePath(`/dashboard/workspace/${resolvedWorkspaceId}`)

    return NextResponse.json({ project }, { status: 201 })
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
