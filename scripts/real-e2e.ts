import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { createClient, type Client } from "@libsql/client"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { and, eq, gte, sql } from "drizzle-orm"
import {
  generationHistory,
  generationJobs,
  projectFiles,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "@/lib/db/schema"

function run(name: string, command: string, args: string[]) {
  const executable = process.platform === "win32" ? "cmd.exe" : command
  const executableArgs = process.platform === "win32" ? ["/d", "/s", "/c", `${command} ${args.join(" ")}`] : args
  const result = spawnSync(executable, executableArgs, {
    cwd: process.cwd(),
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
  })

  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim()
    throw new Error(`${name} failed\n${output.slice(-4000)}`)
  }
}

async function verifyPersistence(db: LibSQLDatabase<Record<string, never>>, tag: string) {
  const userId = crypto.randomUUID()
  const workspaceId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  let rowsWritten = false

  try {
    await db.insert(users).values({
      id: userId,
      email: `${tag}@example.test`,
      name: "Real E2E",
    })

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "Real E2E Workspace",
      slug: tag,
      createdBy: userId,
    })

    await db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      userId,
      workspaceId,
      role: "admin",
    })

    await db.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Real E2E Project",
      prompt: "real e2e persistence",
    })

    await db.insert(generationHistory).values({
      id: crypto.randomUUID(),
      projectId,
      prompt: "real e2e persistence",
      result: "[]",
    })

    await db.insert(projectFiles).values([
      {
        id: crypto.randomUUID(),
        projectId,
        path: "app/page.tsx",
        content: "export default function Page(){return null}",
        language: "tsx",
      },
      {
        id: crypto.randomUUID(),
        projectId,
        path: "lib/e2e.ts",
        content: "export const ok = true",
        language: "typescript",
      },
    ])
    rowsWritten = true

    const fileCountRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId))
    const historyCountRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(generationHistory)
      .where(eq(generationHistory.projectId, projectId))

    const fileCount = Number(fileCountRows[0]?.count ?? 0)
    const historyCount = Number(historyCountRows[0]?.count ?? 0)

    assert(fileCount > 0, "persistence failed: no project files were written")
    assert(historyCount > 0, "persistence failed: no generation history was written")

    return {
      fileWrites: { count: fileCount },
      databaseWrites: { count: fileCount + historyCount },
    }
  } finally {
    if (rowsWritten) {
      await db.delete(projectFiles).where(eq(projectFiles.projectId, projectId)).catch(() => null)
      await db.delete(generationHistory).where(eq(generationHistory.projectId, projectId)).catch(() => null)
      await db.delete(projects).where(eq(projects.id, projectId)).catch(() => null)
      await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId)).catch(() => null)
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId)).catch(() => null)
      await db.delete(users).where(eq(users.id, userId)).catch(() => null)
    }
  }
}

async function verifyWorkerFailedGate(db: LibSQLDatabase<Record<string, never>>) {
  const windowMinutes = Math.max(1, Number(process.env.DEPLOY_GATE_WORKER_FAILED_WINDOW_MINUTES || 60))
  const since = new Date(Date.now() - windowMinutes * 60 * 1000)

  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(generationJobs)
    .where(and(eq(generationJobs.status, "failed"), gte(generationJobs.failedAt, since)))

  const workerFailed = Number(rows[0]?.count ?? 0)
  assert(workerFailed === 0, `deploy blocked: worker_failed count is ${workerFailed} in the last ${windowMinutes} minute(s)`)
  return { workerFailed, windowMinutes }
}

async function main() {
  const databaseUrl = process.env.TURSO_DATABASE_URL
  assert(databaseUrl, "TURSO_DATABASE_URL is required for real-e2e persistence gate")

  run("runtime_smoke", "npm", ["run", "runtime-smoke"])

  const client: Client = createClient({
    url: databaseUrl,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  })

  try {
    const db = drizzle(client)
    const persistence = await verifyPersistence(db, `real-e2e-${Date.now()}`)
    const worker = await verifyWorkerFailedGate(db)
    console.log(
      JSON.stringify({
        deployGate: "enabled",
        runtimeSmoke: "passed",
        persistence,
        worker,
      })
    )
  } finally {
    try {
      client.close()
    } catch {
      // ignore close errors
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
