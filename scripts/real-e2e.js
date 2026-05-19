const { spawnSync } = require("node:child_process")
const { loadEnvConfig } = require("@next/env")
const { PrismaClient } = require("@prisma/client")

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function run(name, command, args) {
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

async function verifyPersistence(prisma) {
  const tag = `codex-real-e2e-${Date.now()}`
  const user = await prisma.user.create({
    data: {
      email: `${tag}@example.test`,
      name: "Codex Real E2E",
    },
  })

  try {
    const workspace = await prisma.workspace.create({
      data: {
        name: "Codex Real E2E",
        slug: tag,
        createdBy: user.id,
      },
    })
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: "admin",
      },
    })
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Codex Real E2E",
        prompt: "real e2e persistence",
      },
    })
    await prisma.generationHistory.create({
      data: {
        projectId: project.id,
        prompt: "real e2e persistence",
        result: "[]",
      },
    })
    const fileWrite = await prisma.projectFile.createMany({
      data: [
        {
          projectId: project.id,
          path: "app/page.tsx",
          content: "export default function Page(){return null}",
          language: "tsx",
        },
        {
          projectId: project.id,
          path: "lib/e2e.ts",
          content: "export const ok = true",
          language: "typescript",
        },
      ],
    })
    const fileCount = await prisma.projectFile.count({ where: { projectId: project.id } })
    const historyCount = await prisma.generationHistory.count({ where: { projectId: project.id } })

    assert(fileWrite.count > 0 && fileCount > 0, "persistence failed: no project files were written")
    assert(historyCount > 0, "persistence failed: no generation history was written")

    return {
      fileWrites: { count: fileCount },
      databaseWrites: { count: fileCount + historyCount },
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => null)
  }
}

async function verifyWorkerFailedGate(prisma) {
  const windowMinutes = Math.max(1, Number(process.env.DEPLOY_GATE_WORKER_FAILED_WINDOW_MINUTES || 60))
  const since = new Date(Date.now() - windowMinutes * 60 * 1000)
  const workerFailed = await prisma.generationJob.count({
    where: {
      status: "failed",
      failedAt: { gte: since },
    },
  })

  assert(workerFailed === 0, `deploy blocked: worker_failed count is ${workerFailed} in the last ${windowMinutes} minute(s)`)
  return { workerFailed, windowMinutes }
}

async function main() {
  assert(process.env.DATABASE_URL, "DATABASE_URL is required for real-e2e persistence gate")

  run("runtime_smoke", "npm", ["run", "runtime-smoke"])

  const prisma = new PrismaClient()
  try {
    const persistence = await verifyPersistence(prisma)
    const worker = await verifyWorkerFailedGate(prisma)
    console.log(JSON.stringify({
      deployGate: "enabled",
      runtimeSmoke: "passed",
      persistence,
      worker,
    }))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
