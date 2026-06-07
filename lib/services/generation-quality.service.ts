import { prisma } from "@/lib/db/client"
import { log } from "@/lib/logging"

export type GenerationQualityStage =
  | "intent-analysis"
  | "app-classification"
  | "architecture-planning"
  | "dependency-planning"
  | "file-graph-planning"
  | "code-generation"
  | "static-validation"
  | "preview-compile"
  | "typecheck"
  | "lint"
  | "build"
  | "runtime-smoke"
  | "repair"
  | "persistence"
  | "deploy"
  | "unknown"

export type GenerationQualitySummaryInput = {
  jobId: string
  userId: string
  projectId: string
  appType: string
  status: "completed" | "failed" | "cancelled"
  failureStage?: GenerationQualityStage | string | null
  failureCode?: string | null
  buildPassed?: boolean
  runtimePassed?: boolean
  repairSucceeded?: boolean
  deployValidated?: boolean
  repairAttempts?: number
  userRetryCount?: number
  providerLatencyMs?: number
  validationLatencyMs?: number
  totalLatencyMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  estimatedCost?: number
  metadata?: Record<string, unknown> | null
}

export type GenerationFailureCategory =
  | "validator_failed"
  | "repair_failed"
  | "compile_failed"
  | "runtime_failed"
  | "context_overflow"
  | "provider_failed"

export type RuntimeGenerationFailureCategory =
  | "hydration_failed"
  | "import_failed"
  | "dependency_failed"
  | "route_failed"
  | "environment_failed"
  | "sandbox_failed"
  | "rendering_failed"

export type RenderingGenerationFailureCategory =
  | "client_server_boundary_failed"
  | "provider_missing"
  | "props_mismatch"
  | "async_render_failed"
  | "layout_failed"
  | "component_tree_failed"
  | "state_initialization_failed"

function safeStringify(value: unknown) {
  if (value === undefined) return undefined
  if (value === null) return null
  return JSON.stringify(value)
}

export class GenerationQualityService {
  static async recordSummary(input: GenerationQualitySummaryInput) {
    const data = {
      userId: input.userId,
      projectId: input.projectId,
      appType: input.appType,
      status: input.status,
      failureStage: input.failureStage || null,
      failureCode: input.failureCode || null,
      buildPassed: Boolean(input.buildPassed),
      runtimePassed: Boolean(input.runtimePassed),
      repairSucceeded: Boolean(input.repairSucceeded),
      deployValidated: Boolean(input.deployValidated),
      repairAttempts: Math.max(0, input.repairAttempts || 0),
      userRetryCount: Math.max(0, input.userRetryCount || 0),
      providerLatencyMs: Math.max(0, Math.round(input.providerLatencyMs || 0)),
      validationLatencyMs: Math.max(0, Math.round(input.validationLatencyMs || 0)),
      totalLatencyMs: Math.max(0, Math.round(input.totalLatencyMs || 0)),
      promptTokens: Math.max(0, input.promptTokens || 0),
      completionTokens: Math.max(0, input.completionTokens || 0),
      totalTokens: Math.max(0, input.totalTokens || 0),
      estimatedCost: Math.max(0, input.estimatedCost || 0),
      metadataJson: safeStringify(input.metadata),
    }

    const metric = await prisma.generationQualityMetric.upsert({
      where: { jobId: input.jobId },
      create: {
        jobId: input.jobId,
        ...data,
      },
      update: data,
    })

    log("info", "Generation quality metric recorded", {
      jobId: input.jobId,
      projectId: input.projectId,
      appType: input.appType,
      status: input.status,
      failureStage: input.failureStage || null,
      buildPassed: data.buildPassed,
      runtimePassed: data.runtimePassed,
      repairAttempts: data.repairAttempts,
      totalLatencyMs: data.totalLatencyMs,
      totalTokens: data.totalTokens,
    })

    return metric
  }

  static async summarizeRecent(days = 7) {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000)
    const metrics = await prisma.generationQualityMetric.findMany({
      where: {
        createdAt: { gte: since },
      },
      select: {
        appType: true,
        status: true,
        failureStage: true,
        failureCode: true,
        buildPassed: true,
        runtimePassed: true,
        repairSucceeded: true,
        deployValidated: true,
        repairAttempts: true,
        totalLatencyMs: true,
        totalTokens: true,
      estimatedCost: true,
      metadataJson: true,
    },
    })

    const total = metrics.length
    const completed = metrics.filter((metric) => metric.status === "completed").length
    const buildPassed = metrics.filter((metric) => metric.buildPassed).length
    const runtimePassed = metrics.filter((metric) => metric.runtimePassed).length
    const repaired = metrics.filter((metric) => metric.repairSucceeded).length
    const deployValidated = metrics.filter((metric) => metric.deployValidated).length
    const byFailureStage = new Map<string, number>()

    for (const metric of metrics) {
      if (!metric.failureStage) continue
      byFailureStage.set(metric.failureStage, (byFailureStage.get(metric.failureStage) || 0) + 1)
    }
    const failureBreakdownCounts = buildFailureBreakdown(metrics)

    const average = (values: number[]) =>
      values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)

    return {
      windowDays: days,
      sampleCount: total,
      generationSuccessRate: rate(completed, total),
      buildSuccessRate: rate(buildPassed, total),
      runtimeSuccessRate: rate(runtimePassed, total),
      repairSuccessRate: rate(repaired, Math.max(1, metrics.filter((metric) => metric.repairAttempts > 0).length)),
      deploySuccessRate: rate(deployValidated, total),
      averageRepairAttempts: average(metrics.map((metric) => metric.repairAttempts)),
      averageGenerationLatencyMs: average(metrics.map((metric) => metric.totalLatencyMs)),
      averageTokenCost: average(metrics.map((metric) => metric.totalTokens)),
      averageEstimatedCost: average(metrics.map((metric) => metric.estimatedCost)),
      failuresByStage: Object.fromEntries(Array.from(byFailureStage.entries()).sort((left, right) => right[1] - left[1])),
      failureBreakdown: formatFailureBreakdown(failureBreakdownCounts),
      failureBreakdownCounts,
      runtimeBreakdown: formatRuntimeBreakdown(buildRuntimeBreakdown(metrics)),
      renderingBreakdown: formatRenderingBreakdown(buildRenderingBreakdown(metrics)),
      repairBreakdown: buildRepairBreakdown(metrics),
    }
  }

  static async markLatestDeployOutcome(input: {
    projectId: string
    success: boolean
    failureCode?: string | null
    metadata?: Record<string, unknown> | null
  }) {
    const latest = await prisma.generationQualityMetric.findFirst({
      where: {
        projectId: input.projectId,
      },
      orderBy: { createdAt: "desc" },
    })

    if (!latest) return null

    return prisma.generationQualityMetric.update({
      where: { id: latest.id },
      data: {
        deployValidated: input.success,
        failureStage: input.success ? latest.failureStage : "deploy",
        failureCode: input.success ? latest.failureCode : input.failureCode || "deploy_failed",
        metadataJson: safeStringify({
          previous: parseJsonObject(latest.metadataJson),
          deploy: {
            success: input.success,
            checkedAt: new Date().toISOString(),
            ...(input.metadata || {}),
          },
        }),
      },
    })
  }
}

export function classifyRuntimeGenerationFailure(input: {
  status: string
  failureStage?: string | null
  failureCode?: string | null
  metadataJson?: string | null
}): RuntimeGenerationFailureCategory | null {
  const broad = classifyGenerationFailure(input)
  if (broad !== "runtime_failed") return null
  const metadata = parseJsonObject(input.metadataJson ?? null)
  const raw = [input.failureStage, input.failureCode, metadata ? JSON.stringify(metadata) : ""].join(" ").toLowerCase()
  if (/hydration/.test(raw)) return "hydration_failed"
  if (/module not found|cannot find module|can't resolve|missing dependency/.test(raw)) return "dependency_failed"
  if (/environment|process\.env|database_url|nextauth|supabase|openrouter|agentrouter/.test(raw)) return "environment_failed"
  if (/import|export|does not provide an export/.test(raw)) return "import_failed"
  if (/route|api_route|homepage_render|route_render|returned 5\d\d/.test(raw)) return "route_failed"
  if (/sandbox|server_unreachable|timeout|preview server exited/.test(raw)) return "sandbox_failed"
  return "rendering_failed"
}

export function classifyRenderingGenerationFailure(input: {
  status: string
  failureStage?: string | null
  failureCode?: string | null
  metadataJson?: string | null
}): RenderingGenerationFailureCategory | null {
  const runtime = classifyRuntimeGenerationFailure(input)
  if (runtime !== "rendering_failed") return null
  const metadata = parseJsonObject(input.metadataJson ?? null)
  const raw = [input.failureStage, input.failureCode, metadata ? JSON.stringify(metadata) : ""].join(" ").toLowerCase()
  if (/client_server_boundary_failed|server component|client component|use client|event handlers cannot be passed|createcontext/.test(raw)) return "client_server_boundary_failed"
  if (/provider_missing|missing provider|must be used within|usecontext|provider/.test(raw)) return "provider_missing"
  if (/props_mismatch|props|property|undefined|null|cannot read properties|is not a function/.test(raw)) return "props_mismatch"
  if (/async_render_failed|async|promise|suspense|uncached promise|thenable/.test(raw)) return "async_render_failed"
  if (/layout_failed|root layout|layout|html|body|metadata/.test(raw)) return "layout_failed"
  if (/state_initialization_failed|usestate|initial state|initializer|reducer|setstate|state/.test(raw)) return "state_initialization_failed"
  return "component_tree_failed"
}

export function classifyGenerationFailure(input: {
  status: string
  failureStage?: string | null
  failureCode?: string | null
  metadataJson?: string | null
}): GenerationFailureCategory | null {
  if (input.status !== "failed") return null

  const metadata = parseJsonObject(input.metadataJson ?? null)
  const raw = [
    input.failureStage,
    input.failureCode,
    metadata ? JSON.stringify(metadata) : "",
  ].join(" ").toLowerCase()

  if (/context[_ -]?overflow|context length|token limit|too many files|max(total)?chars|64kb|maxfiles/.test(raw)) {
    return "context_overflow"
  }
  if (/provider|openrouter|agentrouter|429|rate limit|fetch failed|network|timeout|model|api key/.test(raw)) {
    return "provider_failed"
  }
  if (/repair|validator_deadlock|max_retries|repeated_identical|empty_repair|malformed_repair/.test(raw)) {
    return "repair_failed"
  }
  if (/runtime-smoke|runtime smoke|preview|sandbox|browser|page\.goto/.test(raw)) {
    return "runtime_failed"
  }
  if (/preview-compile|typecheck|lint|build|compile|tsc|typescript|next build|module not found/.test(raw)) {
    return "compile_failed"
  }
  return "validator_failed"
}

function buildFailureBreakdown(metrics: Array<{
  status: string
  failureStage: string | null
  estimatedCost?: number
  metadataJson?: string | null
  failureCode?: string | null
}>) {
  const counts: Record<GenerationFailureCategory, number> = {
    validator_failed: 0,
    repair_failed: 0,
    compile_failed: 0,
    runtime_failed: 0,
    context_overflow: 0,
    provider_failed: 0,
  }

  for (const metric of metrics) {
    const category = classifyGenerationFailure(metric)
    if (category) counts[category] += 1
  }

  return counts
}

function formatFailureBreakdown(counts: Record<GenerationFailureCategory, number>) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key,
      `${total === 0 ? 0 : Math.round((value / total) * 1000) / 10}%`,
    ])
  ) as Record<GenerationFailureCategory, string>
}

function buildRuntimeBreakdown(metrics: Array<{
  status: string
  failureStage: string | null
  metadataJson?: string | null
  failureCode?: string | null
}>) {
  const counts: Record<RuntimeGenerationFailureCategory, number> = {
    hydration_failed: 0,
    import_failed: 0,
    dependency_failed: 0,
    route_failed: 0,
    environment_failed: 0,
    sandbox_failed: 0,
    rendering_failed: 0,
  }
  for (const metric of metrics) {
    const category = classifyRuntimeGenerationFailure(metric)
    if (category) counts[category] += 1
  }
  return counts
}

function formatRuntimeBreakdown(counts: Record<RuntimeGenerationFailureCategory, number>) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key,
      `${total === 0 ? 0 : Math.round((value / total) * 1000) / 10}%`,
    ])
  ) as Record<RuntimeGenerationFailureCategory, string>
}

function buildRenderingBreakdown(metrics: Array<{
  status: string
  failureStage: string | null
  metadataJson?: string | null
  failureCode?: string | null
}>) {
  const counts: Record<RenderingGenerationFailureCategory, number> = {
    client_server_boundary_failed: 0,
    provider_missing: 0,
    props_mismatch: 0,
    async_render_failed: 0,
    layout_failed: 0,
    component_tree_failed: 0,
    state_initialization_failed: 0,
  }
  for (const metric of metrics) {
    const category = classifyRenderingGenerationFailure(metric)
    if (category) counts[category] += 1
  }
  return counts
}

function formatRenderingBreakdown(counts: Record<RenderingGenerationFailureCategory, number>) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key,
      `${total === 0 ? 0 : Math.round((value / total) * 1000) / 10}%`,
    ])
  ) as Record<RenderingGenerationFailureCategory, string>
}

function buildRepairBreakdown(metrics: Array<{
  status: string
  repairSucceeded: boolean
  repairAttempts: number
  metadataJson?: string | null
}>) {
  const attempted = metrics.filter((metric) => metric.repairAttempts > 0)
  const succeeded = attempted.filter((metric) => metric.repairSucceeded).length
  const failed = attempted.length - succeeded
  return {
    attempted: attempted.length,
    succeeded,
    failed,
    successRate: rate(succeeded, attempted.length),
    failedRate: rate(failed, attempted.length),
  }
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function parseJsonObject(value: string | null) {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
