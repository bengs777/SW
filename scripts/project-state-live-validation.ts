import fs from "node:fs"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { disconnectPrisma, getDatabasePoolUsage, getPrismaRuntimeStats, prisma } from "@/lib/db/client"
import { getDatabaseMetricsSnapshot } from "@/lib/db/metrics"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { DEFAULT_SWIFT_TIER_KEY } from "@/lib/ai/swift-tiers"
import { cleanupDedicatedUserSandbox } from "@/lib/project-state/sandbox-isolation"
import { getReportStoragePath } from "@/lib/runtime/report-storage"
import { splitWorkspaceStateFiles } from "@/lib/workspace-state"
import type { GeneratedFile } from "@/lib/types"

const REPORT_ROOT = path.join(getReportStoragePath(), "project-state-live-validation")
const LIVE_COUNT = Math.max(1, Number(process.env.SWIFT_PROJECT_STATE_LIVE_COUNT || 10))
const GENERATION_TIMEOUT_MS = Math.max(60_000, Number(process.env.SWIFT_PROJECT_STATE_LIVE_TIMEOUT_MS || 300_000))
const MAX_CONCURRENT_CHILDREN = Math.max(1, Math.min(2, Number(process.env.SWIFT_PROJECT_STATE_MAX_CONCURRENT_CHILDREN || 2)))

type PromptCase = {
  id: string
  category: string
  prompt: string
  edit?: boolean
}

type CaseResult = {
  id: string
  category: string
  status: string
  stage: string
  success: boolean
  durationMs: number
  error: string | null
  resultHistoryId: string | null
  metrics: any
  lifecycleBreakdown?: any
  lifecycleEvents?: string[]
  artifactEvents?: any[]
  bottleneckStage?: string | null
  taskgraphFailureReason?: string | null
  taskgraphFailureReportPath?: string | null
  artifactPath?: string | null
}

type BatchProgress = {
  completed: number
  failed: number
  skipped: number
  running: number
  averageLatencyMs: number
}

function loadLocalEnv() {
  for (const file of [".env.local", ".env.production", ".env"]) {
    const filePath = path.join(process.cwd(), file)
    if (!fs.existsSync(filePath)) continue
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
      if (!match) continue
      const [, key, rawValue] = match
      if (process.env[key]) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "")
    }
  }
}

function rate(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10
}

function avg(values: number[]) {
  return values.length === 0 ? 0 : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

function promptSuite(): PromptCase[] {
  return [
    { id: "marketplace-1", category: "marketplace", prompt: "Modify the existing app into a local marketplace dashboard. Change only app/page.tsx, lib/data.ts, and components/site-header.tsx." },
    { id: "marketplace-2", category: "marketplace", prompt: "Add marketplace product status and seller summary to the existing homepage. Keep edits scoped to current files." },
    { id: "marketplace-3", category: "marketplace", prompt: "Create a small marketplace product card component and wire it into app/page.tsx." },
    { id: "saas-1", category: "SaaS", prompt: "Modify the existing app into a SaaS workspace overview with plan usage and onboarding tasks. Change at most five files." },
    { id: "saas-2", category: "SaaS", prompt: "Add SaaS billing state and API key status to the existing dashboard copy and local data." },
    { id: "saas-3", category: "SaaS", prompt: "Patch the navbar label and homepage sections for a subscription analytics SaaS." },
    { id: "dashboard-1", category: "dashboard", prompt: "Modify the app into an operations dashboard with KPI cards, activity feed, and alerts." },
    { id: "dashboard-2", category: "dashboard", prompt: "Add warehouse dashboard metrics using existing app/page.tsx and lib/data.ts only." },
    { id: "dashboard-3", category: "dashboard", prompt: "Patch the existing dashboard headings to focus on logistics SLA risk." },
    { id: "crm-1", category: "CRM", prompt: "Modify the app into a CRM pipeline overview with leads, deal stages, and next actions." },
    { id: "crm-2", category: "CRM", prompt: "Add account health cards and follow-up tasks to the existing CRM page." },
    { id: "blog-1", category: "blog", prompt: "Modify the app into a technology blog homepage with featured article, categories, and newsletter block." },
    { id: "blog-2", category: "blog", prompt: "Patch the existing content into a village news portal with agenda and announcements." },
    { id: "clinic-1", category: "clinic", prompt: "Modify the app into a clinic appointment dashboard with doctors, queue status, and patient reminders." },
    { id: "clinic-2", category: "clinic", prompt: "Add clinic service cards and appointment status data while preserving current scaffold." },
    { id: "custom-1", category: "custom app", prompt: "Modify the app into a laundry order tracker with pickup, delivery, payment, and status cards." },
    { id: "custom-2", category: "custom app", prompt: "Modify the app into an equipment rental tracker with booking status and return reminders." },
    { id: "edit-1", category: "prompt edit lanjutan", prompt: "Edit lanjutan: only change the hero title line in app/page.tsx to emphasize team productivity.", edit: true },
    { id: "edit-2", category: "prompt edit lanjutan", prompt: "Edit lanjutan: patch components/site-header.tsx so the brand label becomes Swift Ops.", edit: true },
    { id: "edit-3", category: "prompt edit lanjutan", prompt: "Edit lanjutan: update lib/data.ts labels without changing page layout.", edit: true },
  ].slice(0, LIVE_COUNT)
}

function baselineFiles(category: string): GeneratedFile[] {
  return [
    {
      path: "package.json",
      language: "json",
      content: JSON.stringify({
        private: true,
        scripts: { dev: "next dev", build: "next build", start: "next start", typecheck: "tsc --noEmit" },
        dependencies: { next: "16.2.6", react: "19.2.5", "react-dom": "19.2.5", "lucide-react": "^0.564.0" },
        devDependencies: { typescript: "5.7.3", "@types/node": "^22", "@types/react": "19.2.14", "@types/react-dom": "19.2.3" },
      }, null, 2),
    },
    { path: "tsconfig.json", language: "json", content: JSON.stringify({ compilerOptions: { target: "ES2022", jsx: "preserve", strict: true, baseUrl: ".", paths: { "@/*": ["./*"] } } }, null, 2) },
    { path: "app/globals.css", language: "css", content: "body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#111827}*{box-sizing:border-box}" },
    { path: "app/layout.tsx", language: "tsx", content: 'import "./globals.css"\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html> }\n' },
    { path: "components/site-header.tsx", language: "tsx", content: 'export function SiteHeader() { return <header className="border-b bg-white px-6 py-4 font-semibold">Swift Starter</header> }\n' },
    { path: "lib/data.ts", language: "ts", content: `export const items = ["${category}", "workflow", "status", "insight"]\n` },
    { path: "app/page.tsx", language: "tsx", content: 'import { SiteHeader } from "@/components/site-header"\nimport { items } from "@/lib/data"\nexport default function Page() { return <main><SiteHeader /><section className="mx-auto max-w-5xl px-6 py-10"><h1 className="text-3xl font-bold">Swift Starter Project</h1><div className="mt-6 grid gap-3">{items.map((item) => <div key={item} className="rounded border bg-white p-4">{item}</div>)}</div></section></main> }\n' },
  ]
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

async function main() {
  loadLocalEnv()
  const args = parseArgs(process.argv.slice(2))
  if (typeof args["run-case"] === "string") {
    await runSingleCase({
      runId: String(args["run-id"] || `project-state-live-${new Date().toISOString().replace(/[:.]/g, "-")}`),
      caseId: args["run-case"],
      reportDir: String(args["report-dir"] || path.join(REPORT_ROOT, String(args["run-id"] || "single-case"))),
    })
    return
  }

  await runBatch()
}

async function runBatch() {
  const startedAt = Date.now()
  const runId = `project-state-live-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportDir = path.join(REPORT_ROOT, runId)
  await mkdir(reportDir, { recursive: true })

  const dbBefore = await collectDbRuntimeMetrics()
  const results: CaseResult[] = []
  const cases = promptSuite()
  for (let index = 0; index < cases.length; index += MAX_CONCURRENT_CHILDREN) {
    const batch = cases.slice(index, index + MAX_CONCURRENT_CHILDREN)
    const runningProgress = buildProgress(results, batch.length)
    await writeBatchProgress(reportDir, { runId, results, progress: runningProgress })
    const batchResults = await Promise.all(batch.map((promptCase) => runCaseChild({ runId, reportDir, promptCase })))
    results.push(...batchResults)
    await cleanupAfterChildBatch()
    await writeBatchProgress(reportDir, { runId, results, progress: buildProgress(results, 0) })
  }

  const dbAfter = await collectDbRuntimeMetrics()
  const summary = summarize(runId, Date.now() - startedAt, results, {
    before: dbBefore,
    after: dbAfter,
    maxConcurrentChildren: MAX_CONCURRENT_CHILDREN,
  })
  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(path.join(REPORT_ROOT, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(summary, null, 2))
  await disconnectPrisma()
  process.exit(summary.finalStatus === "NOT_READY" ? 2 : 0)
}

async function cleanupAfterChildBatch() {
  await getDatabasePoolUsage().catch(() => null)
}

async function collectDbRuntimeMetrics() {
  const pool = await getDatabasePoolUsage()
  const dbMetrics = getDatabaseMetricsSnapshot()
  const prismaStats = getPrismaRuntimeStats()
  return {
    ...prismaStats,
    activeDbConnections: pool.activeConnections,
    dbPoolUsage: pool.usagePct,
    dbMaxConnections: pool.maxConnections,
    dbPoolError: "error" in pool ? pool.error : null,
    dbConnectionFailures: dbMetrics.db_connection_failures,
    dbRetryCount: dbMetrics.db_retry_count,
    averageQueryTime: dbMetrics.average_query_time,
    p95QueryTime: dbMetrics.P95_query_time,
  }
}

async function runCaseChild(input: { runId: string; reportDir: string; promptCase: PromptCase }): Promise<CaseResult> {
  const caseDir = path.join(input.reportDir, "cases", input.promptCase.id)
  await mkdir(caseDir, { recursive: true })
  const startedAt = Date.now()
  const stdoutPath = path.join(caseDir, "stdout.log")
  const stderrPath = path.join(caseDir, "stderr.log")
  const resultPath = path.join(caseDir, "result.json")
  const child = spawn(process.execPath, [
    "scripts/run-ts-script.js",
    "scripts/project-state-live-validation.ts",
    "--run-case",
    input.promptCase.id,
    "--run-id",
    input.runId,
    "--report-dir",
    input.reportDir,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWIFT_PROJECT_STATE_LIVE_COUNT: String(LIVE_COUNT),
      SWIFT_PROJECT_STATE_MAX_CONCURRENT_CHILDREN: String(MAX_CONCURRENT_CHILDREN),
      DB_CONNECTION_LIMIT: process.env.DB_CONNECTION_LIMIT || "2",
      DB_POOL_TIMEOUT_SECONDS: process.env.DB_POOL_TIMEOUT_SECONDS || "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)))
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)))

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      killChildTree(child.pid)
      const forceResolve = setTimeout(() => resolve({ code: null, signal: "SIGKILL", timedOut: true }), 5_000)
      child.once("exit", (code, signal) => {
        clearTimeout(forceResolve)
        resolve({ code, signal, timedOut: true })
      })
    }, GENERATION_TIMEOUT_MS)
    child.on("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code, signal, timedOut: false })
    })
  })

  const stdout = Buffer.concat(stdoutChunks).toString("utf8")
  const stderr = Buffer.concat(stderrChunks).toString("utf8")
  await writeFile(stdoutPath, stdout, "utf8")
  await writeFile(stderrPath, stderr, "utf8")

  if (fs.existsSync(resultPath)) {
    const result = parseJson(fs.readFileSync(resultPath, "utf8")) as CaseResult | null
    if (result) return result
  }
  const status = parseJson(fs.existsSync(path.join(caseDir, "status.json")) ? fs.readFileSync(path.join(caseDir, "status.json"), "utf8") : null) as any
  const timedOutJob = status?.jobId
    ? await readJobAudit(status.jobId).catch(() => ({ metrics: null, lifecycleEvents: [], artifactEvents: [], lifecycleBreakdown: null, bottleneckStage: null, taskgraphFailureReason: null, taskgraphFailureReportPath: null }))
    : { metrics: null, lifecycleEvents: [], artifactEvents: [], lifecycleBreakdown: null, bottleneckStage: null, taskgraphFailureReason: null, taskgraphFailureReportPath: null }
  const executorTimeoutReportPath = exit.timedOut && status?.jobId && status?.projectId && timedOutJob.bottleneckStage === "executor"
    ? await persistChildExecutorTimeoutReport({
        jobId: status.jobId,
        projectId: status.projectId,
        lifecycleEvents: timedOutJob.executorEvents || [],
      }).catch(() => null)
    : null

  const result: CaseResult = {
    id: input.promptCase.id,
    category: input.promptCase.category,
    status: "failed",
    stage: exit.timedOut ? "timeout" : "failed",
    success: false,
    durationMs: Date.now() - startedAt,
    error: exit.timedOut
      ? `Prompt timed out after ${GENERATION_TIMEOUT_MS}ms`
      : stderr.trim() || stdout.trim() || `Child exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}`,
    resultHistoryId: null,
    metrics: timedOutJob.metrics,
    lifecycleBreakdown: timedOutJob.lifecycleBreakdown,
    lifecycleEvents: timedOutJob.lifecycleEvents,
    artifactEvents: timedOutJob.artifactEvents,
    bottleneckStage: timedOutJob.bottleneckStage,
    taskgraphFailureReason: timedOutJob.taskgraphFailureReason,
    taskgraphFailureReportPath: timedOutJob.taskgraphFailureReportPath || executorTimeoutReportPath,
    artifactPath: path.join(caseDir, "timeout-artifact.json"),
  }
  await writeFile(result.artifactPath!, `${JSON.stringify({
    promptCase: input.promptCase,
    exit,
    stdoutTail: stdout.slice(-8000),
    stderrTail: stderr.slice(-8000),
  }, null, 2)}\n`, "utf8")
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  return result
}

function killChildTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Best-effort cleanup; the timeout artifact records the failure.
    }
  }
}

async function runSingleCase(input: { runId: string; caseId: string; reportDir: string }) {
  const promptCase = promptSuite().find((item) => item.id === input.caseId)
  if (!promptCase) throw new Error(`Unknown prompt case: ${input.caseId}`)
  const caseDir = path.join(input.reportDir, "cases", promptCase.id)
  await mkdir(caseDir, { recursive: true })
  const resultPath = path.join(caseDir, "result.json")
  const itemStartedAt = Date.now()
  let projectId: string | null = null
  let userId: string | null = null

  await writeFile(path.join(caseDir, "status.json"), `${JSON.stringify({
    id: promptCase.id,
    status: "running",
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8")

  try {
    const user = await prisma.user.upsert({
      where: { email: "project-state-live@swift.local" },
      update: {},
      create: {
        email: "project-state-live@swift.local",
        name: "Project State Live Validation",
        isDeveloperAccount: true,
        balance: 0,
      },
    })
    userId = user.id
    const workspace = await prisma.workspace.upsert({
      where: { slug: "project-state-live-validation" },
      update: {},
      create: {
        name: "Project State Live Validation",
        slug: "project-state-live-validation",
        createdBy: user.id,
        members: { create: { userId: user.id, role: "admin" } },
      },
    })
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: `Live ${promptCase.id}`,
        description: promptCase.category,
        framework: "next",
        prompt: promptCase.prompt,
      },
    })
    projectId = project.id
    await ProjectFilesystemService.replaceFiles({
      projectId: project.id,
      files: baselineFiles(promptCase.category),
    })

    const job = await GenerationJobService.create({
      userId: user.id,
      projectId: project.id,
      prompt: promptCase.prompt,
      model: DEFAULT_SWIFT_TIER_KEY,
      provider: "swift",
      idempotencyKey: `${input.runId}:${promptCase.id}`,
      requestHash: `${input.runId}:${promptCase.id}`,
    })
    await writeFile(path.join(caseDir, "status.json"), `${JSON.stringify({
      id: promptCase.id,
      status: "running",
      projectId: project.id,
      jobId: job.id,
      startedAt: new Date(itemStartedAt).toISOString(),
    }, null, 2)}\n`, "utf8")

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS - 5_000)
    try {
      await executeGenerationJob({
        jobId: job.id,
        userId: user.id,
        projectId: project.id,
        prompt: promptCase.prompt,
        selectedModel: DEFAULT_SWIFT_TIER_KEY,
        promptLanguage: /edit lanjutan|ubah|buat/i.test(promptCase.prompt) ? "id" : "en",
        persistenceKey: `${input.runId}:${promptCase.id}`,
        signal: controller.signal,
      }, {
        loadProjectFiles: async (projectId) => splitWorkspaceStateFiles(await ProjectFilesystemService.readFiles(projectId)).files,
        loadGenerationHistoryCount: async (projectId) => prisma.generationHistory.count({ where: { projectId } }),
        loadProjectMemoryJson: async (projectId) => {
          const row = await prisma.project.findUnique({ where: { id: projectId }, select: { memoryJson: true } })
          return row?.memoryJson || null
        },
      })
    } catch (error) {
      await GenerationJobService.update(job.id, {
        status: "failed",
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => null)
    } finally {
      clearTimeout(timeout)
    }

    const finalJob = await prisma.generationJob.findUnique({
      where: { id: job.id },
      select: { status: true, stage: true, error: true, metricsJson: true, resultHistoryId: true },
    })
    const audit = await readJobAudit(job.id)
    const metrics = {
      ...(audit.metrics || {}),
      dbRuntime: await collectDbRuntimeMetrics(),
    }
    const artifactPath = path.join(caseDir, "artifact.json")
    await writeFile(artifactPath, `${JSON.stringify({
      promptCase,
      projectId: project.id,
      jobId: job.id,
      metrics,
      finalJob,
      lifecycleEvents: audit.lifecycleEvents,
      artifactEvents: audit.artifactEvents,
      lifecycleBreakdown: audit.lifecycleBreakdown,
      bottleneckStage: audit.bottleneckStage,
      taskgraphFailureReason: audit.taskgraphFailureReason,
      taskgraphFailureReportPath: audit.taskgraphFailureReportPath,
    }, null, 2)}\n`, "utf8")
    const result: CaseResult = {
      id: promptCase.id,
      category: promptCase.category,
      status: finalJob?.status || "unknown",
      stage: finalJob?.stage || "unknown",
      success: finalJob?.status === "completed",
      durationMs: Date.now() - itemStartedAt,
      error: finalJob?.error || null,
      resultHistoryId: finalJob?.resultHistoryId || null,
      metrics,
      lifecycleBreakdown: audit.lifecycleBreakdown,
      lifecycleEvents: audit.lifecycleEvents,
      artifactEvents: audit.artifactEvents,
      bottleneckStage: audit.bottleneckStage,
      taskgraphFailureReason: audit.taskgraphFailureReason,
      taskgraphFailureReportPath: audit.taskgraphFailureReportPath,
      artifactPath,
    }
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
    await cleanupDedicatedUserSandbox({ userId: user.id, projectId: project.id }).catch(() => null)
    await disconnectPrisma()
    process.exit(result.success ? 0 : 2)
  } catch (error) {
    if (userId && projectId) {
      await cleanupDedicatedUserSandbox({ userId, projectId }).catch(() => null)
    }
    const result: CaseResult = {
      id: promptCase.id,
      category: promptCase.category,
      status: "failed",
      stage: "failed",
      success: false,
      durationMs: Date.now() - itemStartedAt,
      error: error instanceof Error ? error.message : String(error),
      resultHistoryId: null,
      metrics: {
        dbRuntime: await collectDbRuntimeMetrics().catch(() => null),
      },
      artifactPath: path.join(caseDir, "error-artifact.json"),
    }
    await writeFile(result.artifactPath!, `${JSON.stringify({ promptCase, error: result.error }, null, 2)}\n`, "utf8")
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
    await disconnectPrisma().catch(() => null)
    process.exit(2)
  }
}

function summarize(runId: string, durationMs: number, results: any[], dbRuntime: {
  before: Awaited<ReturnType<typeof collectDbRuntimeMetrics>>
  after: Awaited<ReturnType<typeof collectDbRuntimeMetrics>>
  maxConcurrentChildren: number
}) {
  const successes = results.filter((item) => item.success).length
  const projectStateUsed = results.filter((item) =>
    item.metrics?.projectStateLoaded === true || item.lifecycleEvents?.includes("project_state_loaded")
  ).length
  const patchUsed = results.filter((item) =>
    Number(item.metrics?.patchOperations || 0) > 0 || item.lifecycleEvents?.includes("patch_completed")
  ).length
  const fullRewriteCount = results.reduce((sum, item) => sum + Number(item.metrics?.fullRewriteDetected || 0), 0)
  const changedFileAverages = results.map((item) => {
    const events = Number(item.metrics?.changedFileEvents || 0)
    return events > 0 ? Number(item.metrics?.changedFilesTotal || 0) / events : 0
  }).filter((value) => value > 0)
  const generationSuccessRate = rate(successes, results.length)
  const projectStateUsageRate = rate(projectStateUsed, results.length)
  const patchUsageRate = rate(patchUsed, results.length)
  const patchStarted = results.filter((item) =>
    item.lifecycleEvents?.includes("patch_queue_started") || item.lifecycleEvents?.includes("patch_started")
  ).length
  const patchStartRate = rate(patchStarted, results.length)
  const fullRewriteRate = rate(fullRewriteCount, Math.max(1, results.length))
  const averageChangedFiles = avg(changedFileAverages)
  const readinessScore = Math.round(
    (generationSuccessRate >= 90 ? 35 : generationSuccessRate * 0.35) +
      (projectStateUsageRate >= 100 ? 25 : projectStateUsageRate * 0.25) +
      (patchUsageRate >= 90 ? 20 : patchUsageRate * 0.2) +
      (fullRewriteRate === 0 ? 15 : 0) +
      (averageChangedFiles > 0 && averageChangedFiles <= 5 ? 5 : 0)
  )
  const finalStatus =
    readinessScore >= 90 && fullRewriteRate === 0 && generationSuccessRate >= 90
      ? "PRODUCTION_READY"
      : readinessScore >= 75 && fullRewriteRate === 0
        ? "BETA_READY"
        : "NOT_READY"

  return {
    runId,
    durationMs,
    liveGenerationCount: results.length,
    successes,
    failures: results.length - successes,
    projectStateUsageRate,
    patchUsageRate,
    patchStartRate,
    averageChangedFiles,
    generationSuccessRate,
    fullRewriteRate,
    dbMetrics: summarizeDbMetrics(results, dbRuntime),
    failureBreakdown: summarizeFailures(results),
    artifactAudit: summarizeArtifactAudit(results),
    lifecycleBreakdown: summarizeLifecycle(results),
    executorBreakdown: summarizeExecutor(results),
    timeoutBreakdown: summarizeTimeouts(results),
    bottleneckStage: summarizeBottleneck(results),
    readinessScore,
    finalStatus,
    operationTotals: {
      patchOperations: results.reduce((sum, item) => sum + Number(item.metrics?.patchOperations || 0), 0),
      createOperations: results.reduce((sum, item) => sum + Number(item.metrics?.createOperations || 0), 0),
      modifyOperations: results.reduce((sum, item) => sum + Number(item.metrics?.modifyOperations || 0), 0),
      deleteOperations: results.reduce((sum, item) => sum + Number(item.metrics?.deleteOperations || 0), 0),
      fullRewriteDetected: fullRewriteCount,
    },
    results,
  }
}

async function readJobAudit(jobId: string) {
  const [job, events] = await Promise.all([
    prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { metricsJson: true },
    }),
    prisma.generationEvent.findMany({
      where: { jobId },
      orderBy: { sequence: "asc" },
      select: { type: true, stage: true, dataJson: true, createdAt: true },
    }),
  ])
  const metrics = parseJson(job?.metricsJson)
  const lifecycleEvents = events
    .filter((event) => [
      "project_state_loaded",
      "provider_called",
      "first_token_received",
      "early_artifact_persisted",
      "provider_completed",
      "artifact_validation_started",
      "artifact_validation_completed",
      "taskgraph_started",
      "taskgraph_completed",
      "executor_started",
      "executor_operation_started",
      "executor_operation_completed",
      "executor_wait_started",
      "executor_wait_completed",
      "executor_completed",
      "taskgraph_validation_started",
      "taskgraph_validation_completed",
      "operation_validation_started",
      "operation_validation_completed",
      "dependency_validation_started",
      "dependency_validation_completed",
      "patch_queue_started",
      "patch_queue_completed",
      "taskgraph_failure",
      "patch_started",
      "patch_completed",
      "persist_started",
      "persist_completed",
    ].includes(event.type))
    .map((event) => event.type)
  const executorEvents = events
    .filter((event) => event.type.startsWith("executor_") || event.type === "patch_queue_started")
    .map((event) => ({
      type: event.type,
      stage: event.stage,
      data: parseJson(event.dataJson),
      createdAt: event.createdAt.toISOString(),
    }))
  const artifactEvents = events
    .filter((event) => event.type === "artifact_validation_completed")
    .map((event) => ({
      type: event.type,
      stage: event.stage,
      data: parseJson(event.dataJson),
      createdAt: event.createdAt.toISOString(),
    }))
  const taskgraphFailure = [...events].reverse().find((event) => event.type === "taskgraph_failure")
  const taskgraphFailureData = parseJson(taskgraphFailure?.dataJson)
  const lifecycleBreakdown = metrics?.generationLifecycle || latestLifecycleFromEvents(events)
  return {
    metrics,
    lifecycleEvents,
    executorEvents,
    artifactEvents,
    lifecycleBreakdown,
    bottleneckStage: bottleneckFromBreakdown(lifecycleBreakdown),
    taskgraphFailureReason: taskgraphFailureData?.reason || null,
    taskgraphFailureReportPath: taskgraphFailureData?.reportPath || null,
  }
}

async function persistChildExecutorTimeoutReport(input: {
  jobId: string
  projectId: string
  lifecycleEvents: Array<{ type: string; data: any; createdAt: string }>
}) {
  const dir = path.join(getReportStoragePath(), "executor-timeouts", input.jobId)
  await mkdir(dir, { recursive: true })
  const operationQueue = buildExecutorOperationQueue(input.lifecycleEvents)
  const pendingOperations = operationQueue.filter((operation) => operation.status === "pending" || operation.status === "running")
  const activePromises = operationQueue
    .filter((operation) => operation.status === "running")
    .map((operation) => ({
      id: operation.id,
      operation: operation.operation,
      file: operation.file,
      startedAt: operation.startedAt,
    }))
  const writtenAt = new Date().toISOString()
  await Promise.all([
    writeFile(path.join(dir, "pending_operations.json"), `${JSON.stringify({
      jobId: input.jobId,
      projectId: input.projectId,
      writtenAt,
      operations: pendingOperations,
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(dir, "operation_queue.json"), `${JSON.stringify({
      jobId: input.jobId,
      projectId: input.projectId,
      writtenAt,
      operations: operationQueue,
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(dir, "dependency_state.json"), `${JSON.stringify({
      jobId: input.jobId,
      projectId: input.projectId,
      writtenAt,
      reason: "child_timeout_during_executor",
      lastExecutorEvent: input.lifecycleEvents.at(-1) || null,
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(dir, "active_promises.json"), `${JSON.stringify({
      jobId: input.jobId,
      projectId: input.projectId,
      writtenAt,
      activePromises,
    }, null, 2)}\n`, "utf8"),
  ])
  return dir
}

function buildExecutorOperationQueue(events: Array<{ type: string; data: any; createdAt: string }>) {
  const queue = new Map<string, any>()
  for (const event of events) {
    const data = event.data || {}
    const id = String(data.operationId || "")
    if (!id || id === "build_operation_queue" || id === "dependency_install") continue
    if (event.type === "executor_operation_started") {
      queue.set(id, {
        id,
        operation: String(data.operation || ""),
        file: String(data.file || ""),
        status: "running",
        startedAt: event.createdAt,
      })
    }
    if (event.type === "executor_operation_completed") {
      const existing = queue.get(id) || { id }
      queue.set(id, {
        ...existing,
        status: data.status || "completed",
        completedAt: event.createdAt,
        durationMs: data.durationMs,
      })
    }
  }
  return Array.from(queue.values())
}

function latestLifecycleFromEvents(events: Array<{ dataJson: string | null }>) {
  for (const event of [...events].reverse()) {
    const data = parseJson(event.dataJson)
    if (data?.lifecycleBreakdown) return data.lifecycleBreakdown
  }
  return null
}

function summarizeLifecycle(results: any[]) {
  const values = results.map((item) => item.lifecycleBreakdown || item.metrics?.generationLifecycle).filter(Boolean)
  return {
    providerLatencyMs: avg(values.map((item) => Number(item.providerLatencyMs || 0)).filter((value) => value > 0)),
    taskgraphLatencyMs: avg(values.map((item) => Number(item.taskgraphLatencyMs || 0)).filter((value) => value > 0)),
    executorLatencyMs: avg(values.map((item) => Number(item.executorLatencyMs || 0)).filter((value) => value > 0)),
    patchLatencyMs: avg(values.map((item) => Number(item.patchLatencyMs || 0)).filter((value) => value > 0)),
    persistLatencyMs: avg(values.map((item) => Number(item.persistLatencyMs || 0)).filter((value) => value > 0)),
  }
}

function summarizeDbMetrics(results: any[], dbRuntime: {
  before: Awaited<ReturnType<typeof collectDbRuntimeMetrics>>
  after: Awaited<ReturnType<typeof collectDbRuntimeMetrics>>
  maxConcurrentChildren: number
}) {
  const childSnapshots = results
    .map((item) => item.metrics?.dbRuntime)
    .filter(Boolean)
  const childConnectionFailures = childSnapshots.reduce((sum, item) => sum + Number(item.dbConnectionFailures || 0), 0)
  const childRetryCount = childSnapshots.reduce((sum, item) => sum + Number(item.dbRetryCount || 0), 0)
  const childPrismaClients = childSnapshots.reduce((sum, item) => sum + Number(item.prisma_client_count || 0), 0)
  const childActivePrismaClients = childSnapshots.reduce((sum, item) => sum + Number(item.activePrismaClients || 0), 0)
  return {
    maxConcurrentChildren: dbRuntime.maxConcurrentChildren,
    prisma_client_count: dbRuntime.after.prisma_client_count + childPrismaClients,
    activePrismaClients: dbRuntime.after.activePrismaClients + childActivePrismaClients,
    activePrismaClientsAfterRun: dbRuntime.after.activePrismaClients,
    activeDbConnectionsBefore: dbRuntime.before.activeDbConnections,
    activeDbConnectionsAfter: dbRuntime.after.activeDbConnections,
    dbPoolUsageBefore: dbRuntime.before.dbPoolUsage,
    dbPoolUsageAfter: dbRuntime.after.dbPoolUsage,
    dbConnectionFailures: dbRuntime.after.dbConnectionFailures + childConnectionFailures,
    dbRetryCount: dbRuntime.after.dbRetryCount + childRetryCount,
    parent: dbRuntime.after,
    children: childSnapshots,
  }
}

function summarizeArtifactAudit(results: any[]) {
  let attempts = 0
  let completed = 0
  let malformed = 0
  let truncated = 0
  let validTaskGraph = 0
  let recovered = 0

  for (const item of results) {
    const metricAudit = item.metrics?.providerArtifactAudit
    if (metricAudit) {
      attempts += Number(metricAudit.attempts || 0)
      completed += Number(metricAudit.completed || 0)
      malformed += Number(metricAudit.malformed || 0)
      truncated += Number(metricAudit.truncated || 0)
      validTaskGraph += Number(metricAudit.validTaskGraph || 0)
      recovered += Number(metricAudit.recovered || 0)
      continue
    }

    for (const event of item.artifactEvents || []) {
      const audit = event.data?.artifactAudit
      if (!audit) continue
      attempts += 1
      if (audit.objectClosed) completed += 1
      if (!audit.schemaValid) malformed += 1
      if (audit.truncated) truncated += 1
      if (audit.hasTaskGraph) validTaskGraph += 1
      if (audit.recovered) recovered += 1
    }
  }

  return {
    attempts,
    artifactCompletionRate: rate(completed, attempts),
    malformedArtifactRate: rate(malformed, attempts),
    truncatedArtifactRate: rate(truncated, attempts),
    validTaskGraphRate: rate(validTaskGraph, attempts),
    recoveredArtifactRate: rate(recovered, attempts),
  }
}

function summarizeExecutor(results: any[]) {
  const started = results.filter((item) => item.lifecycleEvents?.includes("executor_started")).length
  const completed = results.filter((item) => item.lifecycleEvents?.includes("executor_completed")).length
  const operationStarted = results.reduce((sum, item) =>
    sum + (item.lifecycleEvents || []).filter((event: string) => event === "executor_operation_started").length, 0)
  const operationCompleted = results.reduce((sum, item) =>
    sum + (item.lifecycleEvents || []).filter((event: string) => event === "executor_operation_completed").length, 0)
  const waitStarted = results.filter((item) => item.lifecycleEvents?.includes("executor_wait_started")).length
  const waitCompleted = results.filter((item) => item.lifecycleEvents?.includes("executor_wait_completed")).length
  return {
    executorStartRate: rate(started, results.length),
    executorCompletionRate: rate(completed, Math.max(1, started)),
    executorOperationStarted: operationStarted,
    executorOperationCompleted: operationCompleted,
    executorWaitStartRate: rate(waitStarted, Math.max(1, started)),
    executorWaitCompletionRate: rate(waitCompleted, Math.max(1, waitStarted)),
  }
}

function summarizeTimeouts(results: any[]) {
  const counts = new Map<string, number>()
  for (const item of results) {
    if (item.success) continue
    const reason = item.taskgraphFailureReason ||
      (item.stage === "timeout" ? "child_timeout" : null) ||
      item.bottleneckStage ||
      "generation_error"
    if (!/timeout|executor|queue/i.test(reason)) continue
    counts.set(reason, (counts.get(reason) || 0) + 1)
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((left, right) => right[1] - left[1]))
}

function summarizeBottleneck(results: any[]) {
  const counts = new Map<string, number>()
  for (const item of results) {
    const stage = item.bottleneckStage || bottleneckFromBreakdown(item.lifecycleBreakdown || item.metrics?.generationLifecycle)
    if (!stage) continue
    counts.set(stage, (counts.get(stage) || 0) + 1)
  }
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || null
}

function summarizeFailures(results: any[]) {
  const counts = new Map<string, number>()
  for (const item of results) {
    if (item.success) continue
    const reason = item.taskgraphFailureReason ||
      (item.stage === "timeout" ? "executor_timeout" : null) ||
      item.bottleneckStage ||
      bottleneckFromBreakdown(item.lifecycleBreakdown || item.metrics?.generationLifecycle) ||
      "generation_error"
    counts.set(reason, (counts.get(reason) || 0) + 1)
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((left, right) => right[1] - left[1]))
}

function bottleneckFromBreakdown(breakdown: any) {
  if (!breakdown) return null
  if (breakdown.providerCalledAt && !breakdown.taskgraphStartedAt) return "provider_artifact_completion"
  if (breakdown.taskgraphStartedAt && !breakdown.taskgraphCompletedAt) return "taskgraph"
  if (breakdown.executorStartedAt && !breakdown.executorCompletedAt) return "executor"
  if (breakdown.taskgraphCompletedAt && !breakdown.taskgraphValidationStartedAt) return "taskgraph_validation_not_started"
  if (breakdown.taskgraphValidationStartedAt && !breakdown.taskgraphValidationCompletedAt) return "taskgraph_validation"
  if (breakdown.taskgraphValidationCompletedAt && !breakdown.operationValidationStartedAt) return "operation_validation_not_started"
  if (breakdown.operationValidationStartedAt && !breakdown.operationValidationCompletedAt) return "operation_validation"
  if (breakdown.operationValidationCompletedAt && !breakdown.patchQueueStartedAt && !breakdown.patchStartedAt) return "patch_queue_not_started"
  if (breakdown.patchQueueStartedAt && !breakdown.patchQueueCompletedAt) return "patch_queue"
  if (breakdown.patchQueueCompletedAt && !breakdown.dependencyValidationStartedAt && !breakdown.patchCompletedAt) return "dependency_validation_not_started"
  if (breakdown.dependencyValidationStartedAt && !breakdown.dependencyValidationCompletedAt) return "dependency_validation"
  if (breakdown.patchStartedAt && !breakdown.patchCompletedAt) return "patch"
  if (breakdown.persistStartedAt && !breakdown.persistCompletedAt) return "persist"
  const stages: Array<[string, number]> = [
    ["provider", Number(breakdown.providerLatencyMs || 0)],
    ["taskgraph", Number(breakdown.taskgraphLatencyMs || 0)],
    ["executor", Number(breakdown.executorLatencyMs || 0)],
    ["patch", Number(breakdown.patchLatencyMs || 0)],
    ["persist", Number(breakdown.persistLatencyMs || 0)],
  ]
  const [stage, value] = stages.sort((left, right) => right[1] - left[1])[0]
  return value > 0 ? stage : null
}

function buildProgress(results: CaseResult[], running: number): BatchProgress {
  const completed = results.filter((item) => item.success).length
  const failed = results.filter((item) => !item.success).length
  const skipped = 0
  return {
    completed,
    failed,
    skipped,
    running,
    averageLatencyMs: avg(results.map((item) => item.durationMs).filter((value) => value > 0)),
  }
}

async function writeBatchProgress(reportDir: string, input: { runId: string; results: CaseResult[]; progress: BatchProgress }) {
  await writeFile(path.join(reportDir, "progress.json"), `${JSON.stringify({
    runId: input.runId,
    updatedAt: new Date().toISOString(),
    progress: input.progress,
    results: input.results,
  }, null, 2)}\n`, "utf8")
  await writeFile(path.join(REPORT_ROOT, "latest-progress.json"), `${JSON.stringify({
    runId: input.runId,
    updatedAt: new Date().toISOString(),
    progress: input.progress,
  }, null, 2)}\n`, "utf8")
}

function parseJson(value: string | null | undefined) {
  try {
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

main().catch(async (error) => {
  console.error(error)
  await disconnectPrisma().catch(() => null)
  process.exit(1)
})
