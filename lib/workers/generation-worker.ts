import type { Job } from "bullmq"
import { env } from "@/lib/env"
import { getActiveSwiftModelChain } from "@/lib/ai/swift-tiers"
import { MIN_GENERATION_JOB_TIMEOUT_MS, timeoutConfig } from "@/lib/timeouts"
import {
  createGenerationWorker,
  getGenerationQueue,
  moveGenerationJobToDeadLetter,
  recordGenerationWorkerHeartbeat,
  type GenerationQueuePayload,
} from "@/lib/queue/generation-queue"
import { registerGenerationAbortController } from "@/lib/ai/generation-job-runtime"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { prisma } from "@/lib/db/client"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobCancelledError, GenerationJobService } from "@/lib/services/generation-job.service"
import { OrchestrationRuntimeService, classifyRetryReason } from "@/lib/services/orchestration-runtime.service"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { splitWorkspaceStateFiles } from "@/lib/workspace-state"
import { reconcileStaleGenerationJobs } from "@/lib/services/stale-generation-reconciliation.service"
import { log } from "@/lib/logging"
import { captureException } from "@/lib/observability"
import { createCorrelationIds, traceError, traceExecution } from "@/lib/observability/execution-tracer"
import { classifyRuntimeError, warnIfSlow } from "@/lib/observability/performance-monitor"
import { finishAiTask, recordRetry, startAiTask, updateAiTask } from "@/lib/observability/runtime-metrics"

const GENERATION_JOB_TIMEOUT_MS = Math.max(
  MIN_GENERATION_JOB_TIMEOUT_MS,
  Math.round(timeoutConfig.generationJobMs || env.aiQueueTimeoutMs)
)
const DEPRECATED_MODEL_ENV_KEYS = [
  "OPENROUTER_FREE_MODEL",
  "OPENROUTER_MODEL_ID",
  "SWIFT_FALLBACK_MODEL_1",
  "OPENROUTER_FALLBACK_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
]

class GenerationJobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Generation timed out after ${Math.round(timeoutMs / 1000)}s`)
    this.name = "GenerationJobTimeoutError"
  }
}

async function loadProjectFiles(projectId: string) {
  const files = await ProjectFilesystemService.readFiles(projectId)
  return splitWorkspaceStateFiles(files).files
}

async function loadGenerationHistoryCount(projectId: string) {
  return prisma.generationHistory.count({
    where: { projectId },
  })
}

async function loadProjectMemoryJson(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { memoryJson: true },
  })
  return project?.memoryJson || null
}

export async function processGenerationPayload(
  payload: GenerationQueuePayload,
  queueJobId?: string | number,
  workerId?: string | null,
  queueAttempt = 0
) {
  const abortController = new AbortController()
  const unregisterAbort = registerGenerationAbortController(payload.jobId, abortController)
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const resolvedQueueJobId = queueJobId ? String(queueJobId) : payload.jobId
  const correlation = createCorrelationIds({
    correlationId: payload.correlationId || payload.traceId || payload.jobId,
    traceId: payload.traceId,
    executionChainId: payload.executionChainId,
  })
  const traceContext = {
    taskId: payload.jobId,
    sessionId: payload.userId,
    workerId: workerId || null,
    agentType: "generation-worker",
    correlationId: correlation.correlationId,
    traceId: correlation.traceId,
    executionChainId: correlation.executionChainId,
  }
  let timeoutTriggered = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let lastSuccessfulTransition = "worker_started"
  let execution: Promise<unknown> | null = null

  try {
    const leaseAcquired = await OrchestrationRuntimeService.acquireLease({
      jobId: payload.jobId,
      workerId: String(traceContext.workerId || resolvedQueueJobId),
      traceId: correlation.traceId,
      queueJobId: resolvedQueueJobId,
      leaseMs: GENERATION_JOB_TIMEOUT_MS,
      queueAttempt,
    })
    if (!leaseAcquired) {
      log("warn", "duplicate_job_execution_prevented", {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        workerId: traceContext.workerId,
      })
      return
    }
    startAiTask({
      taskId: payload.jobId,
      sessionId: payload.userId,
      workerId: null,
      agentType: "generation",
      modelUsed: payload.model,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
    })
    traceExecution(traceContext, "worker_started", {
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      retryCount: 0,
    })
    log("info", "Generation worker started", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      requestHash: payload.requestHash,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
    })
    log("info", "worker_started", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
    })
    lastSuccessfulTransition = "orchestrator_started"
    await OrchestrationRuntimeService.persistDurableState({
      jobId: payload.jobId,
      orchestrationState: "running",
      currentPhase: "generating",
      generationProgress: 5,
      workerId: String(traceContext.workerId || resolvedQueueJobId),
      queueAttempt,
      traceId: correlation.traceId,
      recoveryState: {
        state: "running",
        recoveryEligible: false,
        lastSuccessfulTransition,
      },
    }).catch(() => null)

    execution = executeGenerationJob(
      {
        jobId: payload.jobId,
        userId: payload.userId,
        projectId: payload.projectId,
        prompt: payload.prompt,
        selectedModel: payload.model,
        promptLanguage: payload.promptLanguage,
        collaborationMode: payload.collaborationMode,
        previewContext: payload.previewContext,
        correlationId: correlation.correlationId,
        traceId: correlation.traceId,
        executionChainId: correlation.executionChainId,
        persistenceKey: payload.idempotencyKey || payload.requestHash || payload.jobId,
        signal: abortController.signal,
      },
      {
        loadProjectFiles,
        loadGenerationHistoryCount,
        loadProjectMemoryJson,
      }
    )

    await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutTriggered = true
          abortController.abort()
          reject(new GenerationJobTimeoutError(GENERATION_JOB_TIMEOUT_MS))
        }, GENERATION_JOB_TIMEOUT_MS)
      }),
    ])
    lastSuccessfulTransition = "orchestrator_completed"
    const durationMs = Date.now() - startedAt
    warnIfSlow("generation", durationMs, { jobId: payload.jobId, projectId: payload.projectId })
    finishAiTask(payload.jobId, "completed", durationMs)
    traceExecution(traceContext, "task_completed", {
      queueJobId: resolvedQueueJobId,
      durationMs,
    })
    await BillingService.markCompleted(payload.usageLogId, {
      provider: payload.provider,
      model: payload.model,
    }).catch((billingError) => {
      log("error", "Generation billing completion failed", {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        error: billingError instanceof Error ? billingError.message : String(billingError),
      })
      captureException(billingError, {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        source: "billing_completion",
      })
    })
    log("info", "Generation worker finished", {
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
      durationMs,
    })
    log("info", "worker_completed", {
      event: "worker_completed",
      jobId: payload.jobId,
      queueJobId: resolvedQueueJobId,
      projectId: payload.projectId,
      userId: payload.userId,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      executionMode: String(resolvedQueueJobId).startsWith("serverless:") ? "serverless_fallback" : "queue",
    })
    await OrchestrationRuntimeService.releaseLease(payload.jobId, String(traceContext.workerId || resolvedQueueJobId), "terminated")
  } catch (error) {
    const isTimeout = timeoutTriggered || error instanceof GenerationJobTimeoutError
    const timeoutMessage = `Generation timed out after ${Math.round(GENERATION_JOB_TIMEOUT_MS / 1000)}s`
    const errorMessage = isTimeout
      ? timeoutMessage
      : error instanceof Error
        ? error.message
        : String(error)
    const isCancelled =
      error instanceof GenerationJobCancelledError ||
      (error instanceof Error && error.message === "GENERATION_JOB_CANCELLED")

    if (isTimeout) {
      abortController.abort()
      if (execution) {
        await Promise.race([
          execution.catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ])
        log("warn", "generation_timeout_cleanup_completed", {
          jobId: payload.jobId,
          queueJobId: resolvedQueueJobId,
          cleanupWaitMs: 5_000,
          currentStage: lastSuccessfulTransition,
        })
      }
    }

    await BillingService.refundReservation(
      payload.usageLogId,
      payload.userId,
      payload.reservedCost,
      errorMessage
    ).catch((refundError) => {
      log("error", "Generation billing refund failed", {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        error: refundError instanceof Error ? refundError.message : String(refundError),
      })
      captureException(refundError, {
        jobId: payload.jobId,
        usageLogId: payload.usageLogId,
        source: "billing_refund",
      })
    })

    if (isTimeout) {
      await GenerationJobService.appendEvent({
        jobId: payload.jobId,
        type: "worker_timeout",
        stage: "timeout",
        status: "failed",
        message: timeoutMessage,
        data: {
          event: "worker_timeout",
          timeoutMs: GENERATION_JOB_TIMEOUT_MS,
          currentStage: lastSuccessfulTransition,
          idleTimeout: true,
          stalledGenerationDetected: true,
        },
      }).catch(() => null)
      await GenerationJobService.markFailed(payload.jobId, timeoutMessage, "timeout").catch(() => null)
    }

    if (!isCancelled) {
      const retryClass = classifyRetryReason(error, { stage: lastSuccessfulTransition, reason: isTimeout ? "timeout" : null })
      const durationMs = Date.now() - startedAt
      finishAiTask(payload.jobId, "failed", durationMs)
      traceError(traceContext, error, {
        queueJobId: resolvedQueueJobId,
        durationMs,
        timeoutTriggered: isTimeout,
      })
      log("error", "Generation worker failed", {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        error: errorMessage,
        durationMs,
        timeoutMs: GENERATION_JOB_TIMEOUT_MS,
        timeoutTriggered: isTimeout,
        errorCode: classifyRuntimeError(error),
        correlationId: correlation.correlationId,
        traceId: correlation.traceId,
        executionChainId: correlation.executionChainId,
      })
      log("error", "worker_failed", {
        event: "worker_failed",
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        userId: payload.userId,
        error: errorMessage,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        durationMs,
        timeoutMs: GENERATION_JOB_TIMEOUT_MS,
        timeoutTriggered: isTimeout,
        errorCode: classifyRuntimeError(error),
        retryClass,
        correlationId: correlation.correlationId,
        traceId: correlation.traceId,
        executionChainId: correlation.executionChainId,
      })
      captureException(error, {
        jobId: payload.jobId,
        queueJobId: resolvedQueueJobId,
        projectId: payload.projectId,
        userId: payload.userId,
        source: "generation_worker",
      })
      await OrchestrationRuntimeService.persistFailure({
        jobId: payload.jobId,
        trace: { traceId: correlation.traceId, workerId: String(traceContext.workerId || resolvedQueueJobId) },
        eventType: isTimeout ? "worker_timeout" : "worker_failed",
        stage: lastSuccessfulTransition,
        severity: isTimeout ? "critical" : "error",
        reason: errorMessage,
        retryCount: 0,
        terminationReason: isTimeout ? "timeout" : retryClass === "terminal" ? "terminal_failure" : null,
        metadata: {
          queueJobId: resolvedQueueJobId,
          retryClass,
          durationMs,
        },
      }).catch(() => null)
    }
    throw error
  } finally {
    await OrchestrationRuntimeService.releaseLease(
      payload.jobId,
      String(traceContext.workerId || resolvedQueueJobId),
      timeoutTriggered ? "terminated" : "processing"
    ).catch(() => null)
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
    unregisterAbort()
  }
}

export async function processGenerationQueueJob(job: Job<GenerationQueuePayload>, workerId?: string | null) {
  return processGenerationPayload(job.data, job.id, workerId, job.attemptsMade)
}

export function startGenerationWorker() {
  const bootStartedAt = Date.now()
  const workerId = `generation:${process.env.VERCEL_REGION || "local"}:${process.pid}`
  const activeSwiftModelChain = getActiveSwiftModelChain()
  const worker = createGenerationWorker((job) => processGenerationQueueJob(job, workerId))
  const activeJobs = new Map<string, { stage: string; lastSuccessfulTransition: string; startedAt: number }>()

  log("info", "generation_worker_env_snapshot", {
    workerId,
    nodeEnv: env.nodeEnv,
    providerName: env.swiftAiProviderName,
    baseUrl: env.openRouterBaseUrl,
    configuredModel: env.openRouterModel,
    activeSwiftModelChain,
    openRouterModel: process.env.OPENROUTER_MODEL || null,
    swiftAiModelChain: process.env.SWIFT_AI_MODEL_CHAIN || null,
    generationJobTimeoutMs: GENERATION_JOB_TIMEOUT_MS,
    executorHardTimeoutMs: timeoutConfig.executorHardMs,
    executorStuckOperationMs: timeoutConfig.executorStuckOperationMs,
    hasOpenRouterApiKey: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    deprecatedModelEnvKeys: DEPRECATED_MODEL_ENV_KEYS.filter((key) => Boolean(process.env[key]?.trim())),
  })
  log("info", "generation_worker_booted", {
    workerId,
    pid: process.pid,
    concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
    timeoutMs: GENERATION_JOB_TIMEOUT_MS,
    activeSwiftModelChain,
  })
  log("info", "worker_boot", {
    event: "worker_boot",
    workerId,
    jobId: null,
    pid: process.pid,
    concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
    timeoutMs: GENERATION_JOB_TIMEOUT_MS,
    startedAt: new Date(bootStartedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - bootStartedAt,
    error: null,
  })

  void reconcileStaleGenerationJobs().catch((error) => {
    log("error", "Stale generation reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    captureException(error, { source: "stale_generation_reconcile_startup" })
  })

  const heartbeat = () => {
    const active = [...activeJobs.entries()]
    const longestRunningMs = active.reduce((max, [, item]) => Math.max(max, Date.now() - item.startedAt), 0)
    const stalledGenerationDetected = longestRunningMs > GENERATION_JOB_TIMEOUT_MS
    recordGenerationWorkerHeartbeat(workerId, {
      alive: true,
      currentStage: active[0]?.[1].stage || "idle",
      lastSuccessfulTransition: active[0]?.[1].lastSuccessfulTransition || "worker_ready",
      activeJobIds: active.map(([jobId]) => jobId),
      idleTimeoutMs: GENERATION_JOB_TIMEOUT_MS,
      stalledGenerationDetected,
      nodeEnv: env.nodeEnv,
      generationExecutionMode: process.env.SWIFT_GENERATION_EXECUTION_MODE || null,
      timeouts: {
        generationJobMs: GENERATION_JOB_TIMEOUT_MS,
        executorHardMs: timeoutConfig.executorHardMs,
        executorStuckOperationMs: timeoutConfig.executorStuckOperationMs,
      },
    }).catch((error) => {
      log("warn", "Generation worker heartbeat failed", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    log("info", "worker_alive", {
      event: "worker_alive",
      workerId,
      activeJobIds: active.map(([jobId]) => jobId),
      currentStage: active[0]?.[1].stage || "idle",
      lastSuccessfulTransition: active[0]?.[1].lastSuccessfulTransition || "worker_ready",
      idleTimeoutMs: GENERATION_JOB_TIMEOUT_MS,
      stalledGenerationDetected,
    })
  }
  heartbeat()
  const heartbeatIntervalMs = Math.max(5_000, Number(process.env.SWIFT_WORKER_HEARTBEAT_INTERVAL_MS || 15_000))
  const heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs)
  const recoveryTimer = setInterval(() => {
    void OrchestrationRuntimeService.recoverOrphanedJobs(25).catch((error) => {
      log("warn", "worker_orphan_recovery_failed", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, Math.max(30_000, Number(process.env.SWIFT_WORKER_RECOVERY_INTERVAL_MS || 60_000)))
  worker.on("closed", () => {
    clearInterval(heartbeatTimer)
    clearInterval(recoveryTimer)
  })

  worker.on("active", async (job) => {
    if (!job) return
    const endedAt = job.processedOn || Date.now()
    const startedAt = job.timestamp || endedAt
    await GenerationJobService.attachQueueJob(job.data.jobId, job.id || job.data.jobId)
    activeJobs.set(job.data.jobId, {
      stage: "active",
      lastSuccessfulTransition: "worker_active",
      startedAt: Date.now(),
    })
    updateAiTask(job.data.jobId, {
      workerId,
      retryCount: job.attemptsMade,
    })
    if (job.attemptsMade > 0) {
      recordRetry({ jobId: job.data.jobId, queueJobId: job.id, attemptsMade: job.attemptsMade })
    }
    log("info", "generation_worker_job_active", {
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      projectId: job.data.projectId,
      userId: job.data.userId,
      correlationId: job.data.correlationId,
      traceId: job.data.traceId,
      executionChainId: job.data.executionChainId,
    })
    log("info", "worker_active", {
      event: "worker_active",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      queueWaitMs: job.processedOn && job.timestamp ? job.processedOn - job.timestamp : null,
      error: null,
      correlationId: job.data.correlationId,
      traceId: job.data.traceId,
      executionChainId: job.data.executionChainId,
    })
  })

  worker.on("failed", async (job, error) => {
    if (!job) return
    activeJobs.delete(job.data.jobId)
    if (error instanceof GenerationJobCancelledError || error.message === "GENERATION_JOB_CANCELLED") return
    const current = await GenerationJobService.findById(job.data.jobId)
    if (current && current.status !== "failed" && current.status !== "cancelled") {
      await GenerationJobService.markFailed(job.data.jobId, error.message || "Generation worker failed")
    }
    captureException(error, {
      jobId: job.data.jobId,
      queueJobId: job.id,
      source: "generation_worker_failed_event",
    })
    log("error", "worker_failed", {
      event: "worker_failed",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      error: error.message,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      endedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : new Date().toISOString(),
      durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      traceId: job.data.traceId,
      correlationId: job.data.correlationId,
      executionChainId: job.data.executionChainId,
    })
    await moveGenerationJobToDeadLetter({
      payload: job.data,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      error,
    }).catch((deadLetterError) => {
      log("error", "generation_dead_letter_write_failed", {
        jobId: job.data.jobId,
        queueJobId: job.id,
        error: deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError),
      })
    })
    await OrchestrationRuntimeService.markDeadLettered({
      jobId: job.data.jobId,
      workerId,
      reason: error.message || "Generation moved to dead-letter queue",
      retryClass: classifyRetryReason(error, { stage: "worker_failed" }),
      metadata: {
        queueJobId: job.id,
        attemptsMade: job.attemptsMade,
      },
    }).catch((persistError) => {
      log("warn", "dead_letter_state_persist_failed", {
        jobId: job.data.jobId,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      })
    })
  })

  worker.on("completed", async (job) => {
    if (!job) return
    activeJobs.delete(job.data.jobId)
    log("info", "Generation worker completed", {
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      attemptsMade: job.attemptsMade,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
      latencyMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      traceId: job.data.traceId,
      correlationId: job.data.correlationId,
      executionChainId: job.data.executionChainId,
    })
    log("info", "worker_completed", {
      event: "worker_completed",
      workerId,
      jobId: job.data.jobId,
      queueJobId: job.id,
      projectId: job.data.projectId,
      userId: job.data.userId,
      attemptsMade: job.attemptsMade,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      endedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : new Date().toISOString(),
      durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      latencyMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
      error: null,
      traceId: job.data.traceId,
    })
  })

  worker.on("stalled", async (jobId) => {
    const queue = getGenerationQueue()
    const stalledJob = queue ? await queue.getJob(String(jobId)).catch(() => null) : null
    const payload = stalledJob?.data
    log("warn", "generation_worker_job_stalled", {
      workerId,
      queueJobId: jobId,
    })
    log("warn", "worker_stalled", {
      event: "worker_stalled",
      workerId,
      jobId: payload?.jobId || String(jobId),
      queueJobId: jobId,
      projectId: payload?.projectId || null,
      userId: payload?.userId || null,
      startedAt: stalledJob?.processedOn ? new Date(stalledJob.processedOn).toISOString() : null,
      endedAt: new Date().toISOString(),
      durationMs: null,
      error: null,
      traceId: payload?.traceId,
    })
    if (payload?.jobId) {
      activeJobs.delete(payload.jobId)
      await OrchestrationRuntimeService.persistFailure({
        jobId: payload.jobId,
        trace: { traceId: payload.traceId, workerId },
        eventType: "worker_stalled",
        stage: "stalled",
        severity: "critical",
        reason: "BullMQ reported a stalled generation job",
        retryCount: stalledJob?.attemptsMade || 0,
        terminationReason: null,
        metadata: {
          queueJobId: jobId,
          processedOn: stalledJob?.processedOn || null,
        },
      }).catch(() => null)
    }
  })

  worker.on("error", (error) => {
    void recordGenerationWorkerHeartbeat(workerId, {
      alive: false,
      currentStage: "worker_error",
      lastSuccessfulTransition: "worker_error",
      activeJobIds: [...activeJobs.keys()],
      idleTimeoutMs: GENERATION_JOB_TIMEOUT_MS,
      stalledGenerationDetected: false,
    }).catch(() => null)
    log("error", "generation_worker_runtime_error", {
      workerId,
      error: error.message,
      stack: error.stack,
    })
    captureException(error, { source: "generation_worker_runtime", workerId })
  })

  worker.on("ready", () => {
    log("info", "generation_worker_ready", { workerId })
  })

  worker.on("closed", () => {
    log("warn", "generation_worker_closed", { workerId })
  })

  return worker
}
