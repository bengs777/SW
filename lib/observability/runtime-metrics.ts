import { getMemoryUsageSnapshot } from "@/lib/observability/performance-monitor"

type MetricSample = {
  ts: string
  value: number
  meta?: Record<string, unknown>
}

export type AiTaskMetrics = {
  taskId: string
  sessionId: string | null
  workerId: string | null
  agentType: string
  retryCount: number
  startedAt: string
  updatedAt: string
  status: "active" | "completed" | "failed" | "cancelled"
  executionDurationMs: number
  filesChanged: string[]
  dependenciesAdded: string[]
  validatorFailures: string[]
  repairAttempts: number
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  modelUsed: string | null
  correlationId: string
  traceId: string
  executionChainId: string
}

type RuntimeMetricState = {
  startedAt: string
  generationDurations: MetricSample[]
  buildDurations: MetricSample[]
  prismaDurations: MetricSample[]
  redisLatencies: MetricSample[]
  openRouterLatencies: MetricSample[]
  validationResults: MetricSample[]
  retryEvents: MetricSample[]
  workerUtilization: MetricSample[]
  activeTasks: Map<string, AiTaskMetrics>
  completedTasks: AiTaskMetrics[]
}

const MAX_SAMPLES = 250
const state: RuntimeMetricState = {
  startedAt: new Date().toISOString(),
  generationDurations: [],
  buildDurations: [],
  prismaDurations: [],
  redisLatencies: [],
  openRouterLatencies: [],
  validationResults: [],
  retryEvents: [],
  workerUtilization: [],
  activeTasks: new Map(),
  completedTasks: [],
}

function pushSample(samples: MetricSample[], value: number, meta?: Record<string, unknown>) {
  samples.push({
    ts: new Date().toISOString(),
    value: Math.max(0, Math.round(value)),
    meta,
  })
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }
}

function average(samples: MetricSample[]) {
  if (samples.length === 0) return 0
  return Math.round(samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length)
}

function rate(samples: MetricSample[], predicate: (sample: MetricSample) => boolean) {
  if (samples.length === 0) return 0
  return Math.round((samples.filter(predicate).length / samples.length) * 1000) / 10
}

export function startAiTask(input: {
  taskId: string
  sessionId?: string | null
  workerId?: string | null
  agentType?: string
  modelUsed?: string | null
  correlationId: string
  traceId: string
  executionChainId: string
}) {
  const now = new Date().toISOString()
  state.activeTasks.set(input.taskId, {
    taskId: input.taskId,
    sessionId: input.sessionId || null,
    workerId: input.workerId || null,
    agentType: input.agentType || "generation",
    retryCount: 0,
    startedAt: now,
    updatedAt: now,
    status: "active",
    executionDurationMs: 0,
    filesChanged: [],
    dependenciesAdded: [],
    validatorFailures: [],
    repairAttempts: 0,
    tokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    modelUsed: input.modelUsed || null,
    correlationId: input.correlationId,
    traceId: input.traceId,
    executionChainId: input.executionChainId,
  })
}

export function updateAiTask(taskId: string, patch: Partial<Omit<AiTaskMetrics, "taskId" | "startedAt">>) {
  const current = state.activeTasks.get(taskId)
  if (!current) return
  state.activeTasks.set(taskId, {
    ...current,
    ...patch,
    filesChanged: patch.filesChanged || current.filesChanged,
    dependenciesAdded: patch.dependenciesAdded || current.dependenciesAdded,
    validatorFailures: patch.validatorFailures || current.validatorFailures,
    tokenUsage: patch.tokenUsage || current.tokenUsage,
    updatedAt: new Date().toISOString(),
  })
}

export function finishAiTask(taskId: string, status: AiTaskMetrics["status"], durationMs: number) {
  const current = state.activeTasks.get(taskId)
  if (!current) return
  const finished = {
    ...current,
    status,
    executionDurationMs: Math.max(0, Math.round(durationMs)),
    updatedAt: new Date().toISOString(),
  }
  state.activeTasks.delete(taskId)
  state.completedTasks.push(finished)
  if (state.completedTasks.length > 100) {
    state.completedTasks.splice(0, state.completedTasks.length - 100)
  }
  pushSample(state.generationDurations, durationMs, { taskId, status })
}

export function recordBuildDuration(durationMs: number, meta?: Record<string, unknown>) {
  pushSample(state.buildDurations, durationMs, meta)
}

export function recordPrismaDuration(durationMs: number, meta?: Record<string, unknown>) {
  pushSample(state.prismaDurations, durationMs, meta)
}

export function recordRedisLatency(durationMs: number, meta?: Record<string, unknown>) {
  pushSample(state.redisLatencies, durationMs, meta)
}

export function recordOpenRouterLatency(durationMs: number, meta?: Record<string, unknown>) {
  pushSample(state.openRouterLatencies, durationMs, meta)
}

export function recordValidationResult(ok: boolean, meta?: Record<string, unknown>) {
  pushSample(state.validationResults, ok ? 0 : 1, meta)
}

export function recordRetry(meta?: Record<string, unknown>) {
  pushSample(state.retryEvents, 1, meta)
}

export function recordWorkerUtilization(activeJobs: number, concurrency: number, meta?: Record<string, unknown>) {
  const utilizationPct = concurrency > 0 ? Math.min(100, Math.round((activeJobs / concurrency) * 100)) : 0
  pushSample(state.workerUtilization, utilizationPct, meta)
}

export function getRuntimeMetricsSnapshot() {
  return {
    startedAt: state.startedAt,
    activeGenerations: Array.from(state.activeTasks.values()),
    recentGenerations: state.completedTasks.slice(-20),
    averages: {
      generationTimeMs: average(state.generationDurations),
      buildDurationMs: average(state.buildDurations),
      prismaQueryDurationMs: average(state.prismaDurations),
      redisLatencyMs: average(state.redisLatencies),
      openRouterLatencyMs: average(state.openRouterLatencies),
      workerUtilizationPct: average(state.workerUtilization),
    },
    rates: {
      retryFrequencyPct: rate(state.retryEvents, () => true),
      validationFailureRatePct: rate(state.validationResults, (sample) => sample.value > 0),
    },
    counts: {
      generationSamples: state.generationDurations.length,
      buildSamples: state.buildDurations.length,
      prismaSamples: state.prismaDurations.length,
      redisSamples: state.redisLatencies.length,
      openRouterSamples: state.openRouterLatencies.length,
      validationSamples: state.validationResults.length,
      retryEvents: state.retryEvents.length,
    },
    memory: getMemoryUsageSnapshot(),
  }
}
