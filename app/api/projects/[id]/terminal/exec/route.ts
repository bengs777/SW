import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/auth"
import { getProjectAccess } from "@/lib/auth/project-access"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs"

const execAsync = promisify(exec)

export const runtime = "nodejs"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const session = await getSession()
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const access = await getProjectAccess(projectId, { userId: session.userId, email: session.email })
  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const command = String(body?.command || "").trim()
  if (!command) {
    return NextResponse.json({ error: "Command is required" }, { status: 400 })
  }

  // Find sandbox directory
  const root = path.join(process.cwd(), ".swift-sandboxes")
  let targetDir = path.join(root, projectId)
  if (!fs.existsSync(targetDir)) {
    // Check if user-prefixed directory exists
    const candidates = fs.existsSync(root) ? fs.readdirSync(root) : []
    const matching = candidates.find((c) => c.endsWith(projectId))
    if (matching) {
      targetDir = path.join(root, matching)
    }
  }

  if (!fs.existsSync(targetDir)) {
    return NextResponse.json({
      error: "Sandbox directory not initialized. Please load the preview first.",
    }, { status: 404 })
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: targetDir,
      timeout: 30000,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    })
    return NextResponse.json({
      success: true,
      exitCode: 0,
      stdout: stdout || "",
      stderr: stderr || "",
    })
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      exitCode: error?.code || 1,
      stdout: error?.stdout || "",
      stderr: error?.stderr || error?.message || "",
    })
  }
}
