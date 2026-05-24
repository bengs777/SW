import { after, NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { COLLABORATION_MODES } from "@/lib/ai/collaboration-mode"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { enqueueGenerationTask, getGenerationQueueHealth } from "@/lib/queue/generation-queue"
import { processGenerationPayload } from "@/lib/workers/generation-worker"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { log } from "@/lib/logging"
import { createCorrelationIds, traceExecution } from "@/lib/observability/execution-tracer"
import { monitorOperation, warnIfSlow } from "@/lib/observability/performance-monitor"
import { recordPrismaDuration } from "@/lib/observability/runtime-metrics"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { byteSize, generationRequestHash, previewContextAudit } from "@/lib/services/generation-job-request.service"
import { ModelConfigService } from "@/lib/services/model-config.service"

export const runtime = "nodejs"
export const maxDuration = 300
const routeRuntime: string = runtime
const requestedGenerationExecutionMode = (process.env.SWIFT_GENERATION_EXECUTION_MODE || "queue").toLowerCase()
const isVercelProductionRuntime = process.env.VERCEL === "1" && process.env.NODE_ENV === "production"
const generationExecutionMode = requestedGenerationExecutionMode
const serverlessFallbackDisabled = process.env.SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK === "true"
const allowServerlessGenerationFallback =
  generationExecutionMode === "serverless" ||
  process.env.SWIFT_ALLOW_SERVERLESS_GENERATION_FALLBACK === "true" ||
  (isVercelProductionRuntime && !serverlessFallbackDisabled)

const CreateJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().trim().min(1).max(12_000),
  model: z.string().min(1),
  provider: z.string().optional(),
  plan: z.array(z.string()).optional(),
  promptLanguage: z.enum(["id", "en"]).optional().default("id"),
  collaborationMode: z.enum(COLLABORATION_MODES).optional().default("build"),
  idempotencyKey: z.string().trim().max(160).optional(),
  previewContext: z.unknown().optional(),
  attachments: z.array(z.unknown()).optional().default([]),
})

function logStage(stage: string, success: boolean, detail?: Record<string, unknown>) {
  log("info", "generation_job_stage", {
    stage,
    success,
    ...(detail || {}),
  })
}

function logEarlyStage(stage: string, requestId: string, detail?: Record<string, unknown>) {
  log("info", "generation_job_stage", {
    stage,
    requestId,
    ...(detail || {}),
  })
}

function logFatal(stage: string, error: unknown, detail?: Record<string, unknown>) {
  log("error", "generation_job_fatal", {
    stage,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(detail || {}),
  })
}

function probableRootCause(stage: string, error?: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : ""
  if (
    prismaCode === "P2022" ||
    /column .* does not exist|table .* does not exist|relation .* does not exist|schema mismatch/i.test(message)
  ) {
    return "database schema mismatch"
  }
  if (stage === "auth_start") return "Auth session lookup failed before request body parsing."
  if (stage === "body_parse_start") return "Malformed JSON request body or request stream could not be read."
  if (stage === "request_body_parse") return "Malformed JSON request body."
  if (stage === "payload_validation") return "Client payload failed Zod validation."
  if (stage === "previewContext_normalization") return "Preview context shape is invalid or too large."
  if (stage === "request_hash_creation") return "Preview context or attachment payload is not safely serializable for hashing."
  if (stage === "dedupe_lookup") return "Database lookup for idempotent generation failed."
  if (stage === "db_job_creation" && /insufficient balance/i.test(message)) return "Billing reservation rejected because balance is insufficient."
  if (stage === "db_job_creation") return "Atomic billing reservation or GenerationJob insert failed."
  if (stage === "queue_enqueue") return "Redis/BullMQ generation queue is unavailable or rejected the job."
  if (stage === "response_return") return "Response serialization failed after job creation."
  return "Unknown route failure; inspect stack and previous stage logs."
}

function developerGenerationFailureMessage(input: {
  stage: string
  probableRootCause: string
  traceId: string
}) {
  return [
    "Generation failed during:",
    input.stage,
    "",
    "Probable cause:",
    input.probableRootCause,
    "",
    "Trace:",
    input.traceId,
  ].join("\n")
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  let requestId = "unassigned"
  let traceId = requestId
  let correlationId = requestId
  let executionChainId = requestId
  let currentStage = "route_start"
  let failedStage: string | null = null
  let payloadSize = 0
  let previewContextSize = 0
  let hashCreated = false
  let dbCreated = false
  let enqueueSuccess = false
  let fallbackScheduled = false
  let requestHash: string | null = null
  let body: unknown = null
  let developerDiagnosticsAllowed = false

  const auditSummary = (error?: unknown) => {
    const summary = {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      fallbackScheduled,
      probableRootCause: probableRootCause(failedStage || currentStage, error),
    }
    log("info", "generation_job_audit_summary", summary)
    return summary
  }

  const fatalResponse = (stage: string, error: unknown, status = 500, retryable = true) => {
    failedStage = stage
    logFatal(stage, error, {
      requestId,
      traceId,
      payloadSize,
      previewContextSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      fallbackScheduled,
    })
    const summary = auditSummary(error)
    // SECURITY: In production, hide internal stage/root cause details from client
    const isProduction = process.env.NODE_ENV === "production"
    const developerError = developerGenerationFailureMessage({
      stage,
      probableRootCause: summary.probableRootCause,
      traceId,
    })
    const safeError = isProduction
      ? developerDiagnosticsAllowed
        ? developerError
        : "An internal error occurred. Please try again."
      : (error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      {
        error: safeError,
        ...(developerDiagnosticsAllowed || !isProduction
          ? {
              stage,
              probableRootCause: summary.probableRootCause,
              traceId,
              diagnostics: {
                failedDuring: stage,
                probableCause: summary.probableRootCause,
                traceId,
              },
            }
          : {}),
        retryable,
        requestId,
      },
      { status }
    )
  }

  try {
  const correlation = createCorrelationIds({
    correlationId: request.headers.get("x-correlation-id") || request.headers.get("x-request-id") || randomUUID(),
    traceId: request.headers.get("x-trace-id") || request.headers.get("x-vercel-id"),
    executionChainId: request.headers.get("x-execution-chain-id"),
  })
  correlationId = correlation.correlationId
  requestId = correlationId
  traceId = correlation.traceId
  executionChainId = correlation.executionChainId
  currentStage = "request_received"

  traceExecution({
    taskId: requestId,
    sessionId: null,
    agentType: "api-route",
    correlationId,
    traceId,
    executionChainId,
  }, "request_received", {
    runtime: routeRuntime,
  })
  logStage("request_received", true, {
    requestId,
    correlationId,
    traceId,
    executionChainId,
    runtime: routeRuntime,
    runtimeCompatibility: routeRuntime === "edge" ? "risk" : "nodejs_ok",
  })

  if (routeRuntime === "edge") {
    log("warn", "job_runtime_compatibility_risk", {
      runtime: routeRuntime,
      nodeOnlyApis: ["node:crypto.createHash", "Buffer"],
    })
  }

  currentStage = "auth_start"
  logEarlyStage("auth_start", requestId)
  let session: { user?: { email?: string | null } } | null
  try {
    session = await auth()
  } catch (error) {
    log("error", "auth_fatal", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    })
    throw error
  }
  currentStage = "auth_success"
  logEarlyStage("auth_success", requestId)
  const email = session?.user?.email
  developerDiagnosticsAllowed =
    Boolean(email && email.trim().toLowerCase() === env.devOwnerEmail.trim().toLowerCase()) ||
    Boolean(email?.endsWith("@swift.local"))

  if (!email) {
    auditSummary()
    return NextResponse.json({ error: "Authentication required", requestId }, { status: 401 })
  }

  currentStage = "body_parse_start"
  logEarlyStage("body_parse_start", requestId)
  try {
    body = await request.json()
    payloadSize = byteSize(body)
    currentStage = "body_parse_success"
    logEarlyStage("body_parse_success", requestId, { payloadSize })
  } catch (error) {
    log("error", "body_parse_fatal", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      requestId,
    })
    return fatalResponse("body_parse_start", error, 400, false)
  }

  currentStage = "payload_validation"
  logStage("payload_validation", false, { requestId, payloadSize })
  const parsed = await CreateJobSchema.safeParseAsync(body)

  if (!parsed.success) {
    failedStage = "payload_validation"
    log("error", "job_payload_validation_failed", {
      stage: "payload_validation",
      error: "Invalid generation job payload",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    })
    auditSummary(parsed.error)
    return NextResponse.json(
      {
        error: "Invalid generation job payload",
        stage: "payload_validation",
        retryable: false,
        requestId,
      },
      { status: 400 }
    )
  }
  logStage("payload_validation", true, {
    requestId,
    projectId: parsed.data.projectId,
    attachmentsCount: parsed.data.attachments.length,
  })

  currentStage = "previewContext_normalization"
  logStage("previewContext_normalization", false, { requestId })
  const previewAudit = previewContextAudit(parsed.data.previewContext)
  previewContextSize = previewAudit.sizeBytes
  try {
    JSON.stringify(parsed.data.previewContext ?? null)
  } catch (error) {
    log("error", "preview_context_serialization_failed", {
      keys: previewAudit.keys,
      filesCount: previewAudit.filesCount,
      previewFilesCount: previewAudit.previewFilesCount,
      diagnosticsCount: previewAudit.diagnosticsCount,
      sizeBytes: previewContextSize,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return fatalResponse("previewContext_normalization", error, 400, false)
  }

  log("info", "hash_audit", {
    requestId,
    correlationId,
    traceId,
    hasPreviewContext: previewAudit.hasPreviewContext,
    activeFile: previewAudit.activeFile,
    diagnosticsCount: previewAudit.diagnosticsCount,
    selectedPathsCount: previewAudit.selectedPathsCount,
  })
  log("info", "payload_size_audit", {
    requestId,
    correlationId,
    traceId,
    payloadSize,
    previewContextSize,
    diagnosticsCount: previewAudit.diagnosticsCount,
    filesCount: previewAudit.filesCount,
    payloadWarning: payloadSize > 500 * 1024,
    previewContextWarning: previewContextSize > 250 * 1024,
  })
  if (payloadSize > 500 * 1024 || previewContextSize > 250 * 1024) {
    log("warn", "job_payload_size_warning", {
      payloadSize,
      previewContextSize,
      payloadLimit: 500 * 1024,
      previewContextLimit: 250 * 1024,
    })
  }
  logStage("previewContext_normalization", true, {
    requestId,
    hasPreviewContext: previewAudit.hasPreviewContext,
    normalized: Boolean(previewAudit.normalized),
    previewContextSize,
  })

  const userLookupStartedAt = Date.now()
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, isDeveloperAccount: true },
  })
  developerDiagnosticsAllowed = developerDiagnosticsAllowed || Boolean(user?.isDeveloperAccount)
  const userLookupDurationMs = Date.now() - userLookupStartedAt
  recordPrismaDuration(userLookupDurationMs, { operation: "user.findUnique", requestId })
  warnIfSlow("prisma", userLookupDurationMs, { operation: "user.findUnique", requestId })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found", requestId }, { status: 404 })
  }

  const projectLookupStartedAt = Date.now()
  const project = await prisma.project.findFirst({
    where: {
      id: parsed.data.projectId,
      workspace: {
        members: {
          some: {
            userId: user.id,
          },
        },
      },
    },
    select: { id: true },
  })
  const projectLookupDurationMs = Date.now() - projectLookupStartedAt
  recordPrismaDuration(projectLookupDurationMs, { operation: "project.findFirst", requestId })
  warnIfSlow("prisma", projectLookupDurationMs, { operation: "project.findFirst", requestId })

  if (!project) {
    auditSummary()
    return NextResponse.json({ error: "Project not found", requestId }, { status: 404 })
  }

  currentStage = "request_hash_creation"
  logStage("request_hash_creation", false, {
    requestId,
    hasPreviewContext: previewAudit.hasPreviewContext,
    stableObjectOrdering: true,
    hashesRawObject: false,
  })
  try {
    requestHash = generationRequestHash(parsed.data)
    hashCreated = true
    logStage("request_hash_creation", true, {
      requestId,
      requestHash,
      previewContextIncluded: true,
      serialization: "stableJson_sorted_keys",
    })
  } catch (error) {
    return fatalResponse("request_hash_creation", error, 500, true)
  }

  currentStage = "dedupe_lookup"
  logStage("dedupe_lookup", false, { requestId, requestHash })
  const existingJob = await GenerationJobService.findIdempotentJob({
    userId: user.id,
    projectId: project.id,
    idempotencyKey: parsed.data.idempotencyKey,
    requestHash,
  })
  logStage("dedupe_lookup", true, {
    requestId,
    requestHash,
    existingJobId: existingJob?.id || null,
  })

  if (existingJob) {
    log("info", "job_audit_summary", {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      probableRootCause: "none_deduped_existing_job",
    })
    logStage("response_return", true, {
      requestId,
      traceId,
      jobId: existingJob.id,
    })
    return NextResponse.json({
      job: GenerationJobService.toPublicJob(existingJob),
      idempotent: true,
      requestId,
    }, {
      status: 202,
      headers: { "X-Request-Id": requestId },
    })
  }

  const activeGenerationCount = await GenerationJobService.countActiveForUser(user.id)
  if (activeGenerationCount >= env.aiMaxConcurrentGenerations) {
    // Auto-cleanup: check if any "active" jobs are actually stale (stuck > 5 min).
    // This handles the case where worker crashed or serverless timed out, leaving
    // orphaned jobs that block new submissions forever.
    const STUCK_THRESHOLD_MS = 5 * 60_000 // 5 minutes
    const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS)
    const stuckJobs = await prisma.generationJob.findMany({
      where: {
        userId: user.id,
        status: { in: ["queued", "running", "cancelling"] },
        updatedAt: { lt: stuckCutoff },
      },
      select: { id: true },
      take: 5,
    })

    if (stuckJobs.length > 0) {
      // Mark stuck jobs as failed so user can proceed
      for (const stuckJob of stuckJobs) {
        await GenerationJobService.markFailed(
          stuckJob.id,
          "Generation timed out (auto-recovered)"
        ).catch(() => null)
      }
      log("warn", "auto_recovered_stuck_jobs", {
        userId: user.id,
        stuckJobIds: stuckJobs.map((j) => j.id),
        requestId,
      })
      // Don't return 429 — let the user's current request proceed
    } else {
      return NextResponse.json({
        error: "Too many active generation jobs. Wait for an existing job to finish before starting another.",
        requestId,
        activeGenerationCount,
        limit: env.aiMaxConcurrentGenerations,
      }, { status: 429 })
    }
  }

  try {
    await enforceAiUsageRateLimit(user.id)
  } catch (error) {
    auditSummary(error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Rate limit exceeded",
        stage: "rate_limit",
        retryable: true,
        requestId,
      },
      { status: 429 }
    )
  }

  const routingDecision = routeModelForRequest({
    prompt: parsed.data.prompt,
    purpose: "generate",
    attachmentCount: parsed.data.attachments.length,
  })
  const modelConfig = await ModelConfigService.getActiveModelByKey(routingDecision.modelName)

  if (!modelConfig) {
    auditSummary()
    return NextResponse.json({ error: "Selected model is not available", requestId }, { status: 403 })
  }

  const pricing = calculateModelRequestPrice({
    modelKey: modelConfig.key,
    modelName: modelConfig.modelName,
    prompt: parsed.data.prompt,
  })

  let usageLogId: string | null = null
  let jobId: string | null = null

  try {
    currentStage = "db_job_creation"
    log("info", "job_db_create", {
      stage: "db_job_creation",
      success: false,
      requestId,
      projectId: project.id,
      userId: user.id,
      requestHash,
      cost: pricing.estimatedCost,
    })
    const reservation = await monitorOperation("prisma", "job_db_reservation", () => BillingService.reserveGenerationJob({
      userId: user.id,
      projectId: project.id,
      prompt: parsed.data.prompt,
      modelConfigId: modelConfig.id,
      model: modelConfig.key,
      provider: "swift",
      cost: pricing.estimatedCost,
      idempotencyKey: parsed.data.idempotencyKey,
      requestHash,
      traceId,
      plan: parsed.data.plan,
      context: {
        requestId,
        traceId,
        correlationId,
        executionChainId,
        requestHash,
        requestedModel: parsed.data.model,
        routedModel: routingDecision.modelName,
        routing: {
          classification: routingDecision.classification,
          layer: routingDecision.layer,
          reason: routingDecision.reason,
        },
      },
    }), { requestId, correlationId, traceId, executionChainId, projectId: project.id, userId: user.id })
    const { job, usageLog } = reservation
    usageLogId = usageLog.id
    jobId = job.id
    dbCreated = true
    log("info", "job_db_create", {
      stage: "db_job_creation",
      success: true,
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId,
      usageLogId,
      requestHash,
    })
    const queueId = parsed.data.idempotencyKey
      ? ["generation", user.id, project.id, parsed.data.idempotencyKey].join("__")
      : ["generation", user.id, project.id, requestHash].join("__")

    currentStage = "queue_enqueue"
    log("info", "queue_enqueue", {
      stage: "queue_enqueue",
      success: false,
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId,
      queueId,
    })
    const generationPayload = {
      jobId: job.id,
      userId: user.id,
      projectId: project.id,
      prompt: parsed.data.prompt,
      model: modelConfig.key,
      provider: "swift",
      usageLogId,
      reservedCost: pricing.estimatedCost,
      modelConfigId: modelConfig.id,
      promptLanguage: parsed.data.promptLanguage,
      collaborationMode: parsed.data.collaborationMode,
      idempotencyKey: parsed.data.idempotencyKey,
      requestHash,
      correlationId,
      traceId,
      executionChainId,
      previewContext: parsed.data.previewContext,
      attachments: parsed.data.attachments,
    }
    const generationStartedEndedAt = new Date()
    traceExecution({
      taskId: job.id,
      sessionId: user.id,
      agentType: "generation",
      correlationId,
      traceId,
      executionChainId,
    }, "generation_started", {
      projectId: project.id,
      model: modelConfig.key,
    })
    log("info", "generation_started", {
      event: "generation_started",
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId: job.id,
      projectId: project.id,
      userId: user.id,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: generationStartedEndedAt.toISOString(),
      durationMs: generationStartedEndedAt.getTime() - startedAt,
      requestHash,
    })

    const preferServerlessExecution = generationExecutionMode === "serverless"
    const queueHealth = preferServerlessExecution
      ? null
      : await getGenerationQueueHealth().catch((error) => {
          log("warn", "generation_queue_health_check_failed", {
            requestId,
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        })
    const queueUnavailable = !queueHealth || queueHealth.status !== "healthy"
    const shouldUseServerlessFallback = preferServerlessExecution || (allowServerlessGenerationFallback && queueUnavailable)
    if (shouldUseServerlessFallback) {
      log("warn", "generation_queue_worker_unavailable", {
        requestId,
        jobId: job.id,
        executionMode: generationExecutionMode,
        serverlessFallbackAllowed: allowServerlessGenerationFallback,
        vercelProductionRuntime: isVercelProductionRuntime,
        queueStatus: queueHealth?.status || "unknown",
        queueEnabled: queueHealth?.enabled ?? false,
        workerHeartbeat: queueHealth?.workerHeartbeat || null,
      })
    }
    if (!preferServerlessExecution && queueUnavailable && !allowServerlessGenerationFallback) {
      throw new Error(
        `Generation worker unavailable; queue status is ${queueHealth?.status || "unknown"}. Start the dedicated worker or enable serverless fallback.`
      )
    }

    let queueJob: Awaited<ReturnType<typeof enqueueGenerationTask>> | null = null
    if (!shouldUseServerlessFallback) {
      try {
        queueJob = await enqueueGenerationTask(
          generationPayload,
          {
            jobId: queueId,
          }
        )
      } catch (error) {
        if (!allowServerlessGenerationFallback) {
          throw error
        }

        log("warn", "generation_queue_enqueue_failed_falling_back", {
          requestId,
          correlationId,
          traceId,
          executionChainId,
          jobId: job.id,
          queueId,
          error: error instanceof Error ? error.message : String(error),
          code: error && typeof error === "object" && "code" in error ? String(error.code) : null,
          fallback: "serverless",
        })
      }
    }

    if (!queueJob) {
      fallbackScheduled = true
      const fallbackQueueJobId = `serverless:${job.id}`
      void GenerationJobService.attachQueueJob(job.id, fallbackQueueJobId).catch((error) => {
        log("warn", "generation_serverless_fallback_attach_failed", {
          requestId,
          jobId: job.id,
          queueJobId: fallbackQueueJobId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      after(async () => {
        log("warn", "generation_serverless_fallback_started", {
          requestId,
          correlationId,
          traceId,
          executionChainId,
          jobId: job.id,
          queueJobId: fallbackQueueJobId,
          reason: preferServerlessExecution
            ? "serverless_execution_mode"
            : shouldUseServerlessFallback
              ? "queue_worker_unavailable"
              : "queue_unavailable",
        })
        try {
          await processGenerationPayload(generationPayload, fallbackQueueJobId)
          log("info", "generation_serverless_fallback_completed", {
            requestId,
            correlationId,
            traceId,
            executionChainId,
            jobId: job.id,
            queueJobId: fallbackQueueJobId,
          })
        } catch (error) {
          log("error", "generation_serverless_fallback_failed", {
            requestId,
            correlationId,
            traceId,
            executionChainId,
            jobId: job.id,
            queueJobId: fallbackQueueJobId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

      currentStage = "response_return"
      log("warn", "queue_fallback_scheduled", {
        stage: "queue_enqueue",
        success: false,
        fallbackScheduled,
        requestId,
        jobId,
        queueJobId: fallbackQueueJobId,
      })
      log("info", "job_audit_summary", {
        failedStage,
        payloadSize,
        hashCreated,
        dbCreated,
        enqueueSuccess,
        fallbackScheduled,
        probableRootCause: preferServerlessExecution
          ? "serverless_execution_mode"
          : shouldUseServerlessFallback
            ? "queue_worker_unavailable_serverless_fallback_scheduled"
            : "queue_unavailable_serverless_fallback_scheduled",
      })
      logStage("response_return", true, {
        requestId,
        correlationId,
        traceId,
        executionChainId,
        jobId: job.id,
        queueJobId: fallbackQueueJobId,
        usageLogId,
        projectId: project.id,
        userId: user.id,
        requestHash,
        reservedCost: pricing.estimatedCost,
        queueFallback: true,
        durationMs: Date.now() - startedAt,
      })

      return NextResponse.json({
        job: GenerationJobService.toPublicJob(job),
        idempotent: false,
        requestId,
        correlationId,
        traceId,
        executionChainId,
        queueFallback: true,
        billing: {
          usageLogId,
          reservedCost: pricing.estimatedCost,
        },
      }, {
        status: 202,
        headers: {
          "X-Request-Id": requestId,
          "X-Correlation-Id": correlationId,
          "X-Trace-Id": traceId,
          "X-Execution-Chain-Id": executionChainId,
        },
      })
    }
    enqueueSuccess = true
    traceExecution({
      taskId: job.id,
      sessionId: user.id,
      agentType: "generation",
      correlationId,
      traceId,
      executionChainId,
    }, "queue_enqueued", {
      queueJobId: queueJob.id || job.id,
    })
    log("info", "queue_enqueue", {
      stage: "queue_enqueue",
      success: true,
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId,
      queueJobId: queueJob.id || job.id,
    })

    await GenerationJobService.attachQueueJob(job.id, queueJob.id || job.id)
    const publicJob = await GenerationJobService.findById(job.id)

    currentStage = "response_return"
    log("info", "job_audit_summary", {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      fallbackScheduled,
      probableRootCause: "none_job_created_and_enqueued",
    })
    logStage("response_return", true, {
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId: job.id,
      queueJobId: queueJob.id || job.id,
      usageLogId,
      projectId: project.id,
      userId: user.id,
      requestHash,
      reservedCost: pricing.estimatedCost,
      durationMs: Date.now() - startedAt,
    })

    return NextResponse.json({
      job: GenerationJobService.toPublicJob(publicJob || job),
      idempotent: false,
      requestId,
      correlationId,
      traceId,
      executionChainId,
      billing: {
        usageLogId,
        reservedCost: pricing.estimatedCost,
      },
    }, {
      status: 202,
      headers: {
        "X-Request-Id": requestId,
        "X-Correlation-Id": correlationId,
        "X-Trace-Id": traceId,
        "X-Execution-Chain-Id": executionChainId,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue generation"
    const failureStage = currentStage === "queue_enqueue" ? "queue_enqueue" : "db_job_creation"
    failedStage = failureStage
    if (failureStage === "queue_enqueue") {
      log("error", "queue_enqueue_failed", {
        stage: failureStage,
        success: false,
        requestId,
        correlationId,
        traceId,
        executionChainId,
        jobId,
        usageLogId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      })
    } else {
      log("error", "job_db_create_failed", {
        stage: failureStage,
        success: false,
        requestId,
        correlationId,
        traceId,
        executionChainId,
        jobId,
        usageLogId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
    logFatal(failureStage, error, {
      requestId,
      traceId,
      jobId,
      usageLogId,
      requestHash,
    })
    const duplicateJob =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (parsed.data.idempotencyKey || requestHash)

    if (duplicateJob) {
      const existing = await GenerationJobService.findIdempotentJob({
        userId: user.id,
        projectId: project.id,
        idempotencyKey: parsed.data.idempotencyKey,
        requestHash,
      })

      if (existing) {
        log("info", "job_audit_summary", {
          failedStage,
          payloadSize,
          hashCreated,
          dbCreated,
          enqueueSuccess,
          fallbackScheduled,
          probableRootCause: "database_unique_constraint_deduped_existing_job",
        })
        logStage("response_return", true, {
          requestId,
          correlationId,
          traceId,
          executionChainId,
          jobId: existing.id,
        })
        return NextResponse.json({
          job: GenerationJobService.toPublicJob(existing),
          idempotent: true,
          requestId,
          correlationId,
          traceId,
          executionChainId,
        }, {
          status: 202,
          headers: {
            "X-Request-Id": requestId,
            "X-Correlation-Id": correlationId,
            "X-Trace-Id": traceId,
            "X-Execution-Chain-Id": executionChainId,
          },
        })
      }
    }

    if (usageLogId) {
      await BillingService.refundReservation(
        usageLogId,
        user.id,
        pricing.estimatedCost,
        message
      ).catch(() => null)
    }

    if (jobId) {
      await GenerationJobService.markFailed(jobId, message).catch(() => null)
    }

    const summary = auditSummary(error)

    const status = /insufficient balance/i.test(message) ? 402 : 503
    // SECURITY: In production, hide internal stage/root cause from client
    const isProduction = process.env.NODE_ENV === "production"
    const developerError = developerGenerationFailureMessage({
      stage: failureStage,
      probableRootCause: summary.probableRootCause,
      traceId,
    })
    const safeMessage = isProduction
      ? developerDiagnosticsAllowed
        ? developerError
        : (status === 402 ? "Insufficient balance" : "Service temporarily unavailable. Please try again.")
      : message
    return NextResponse.json(
      {
        error: safeMessage,
        ...(developerDiagnosticsAllowed || !isProduction
          ? {
              stage: failureStage,
              probableRootCause: summary.probableRootCause,
              traceId,
              diagnostics: {
                failedDuring: failureStage,
                probableCause: summary.probableRootCause,
                traceId,
              },
            }
          : {}),
        retryable: status !== 402,
        requestId,
      },
      { status }
    )
  }
  } catch (error) {
    const stage = failedStage || currentStage || "uncaught"
    failedStage = stage
    logFatal(stage, error, {
      requestId,
      traceId,
      payloadSize,
      previewContextSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      fallbackScheduled,
    })
    const summary = auditSummary(error)
    // SECURITY: In production, hide internal error details from client
    const isProduction = process.env.NODE_ENV === "production"
    const developerError = developerGenerationFailureMessage({
      stage,
      probableRootCause: summary.probableRootCause,
      traceId,
    })
    const safeError = isProduction
      ? developerDiagnosticsAllowed
        ? developerError
        : "An unexpected error occurred. Please try again."
      : (error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      {
        error: safeError,
        ...(developerDiagnosticsAllowed || !isProduction
          ? {
              stage,
              probableRootCause: summary.probableRootCause,
              traceId,
              diagnostics: {
                failedDuring: stage,
                probableCause: summary.probableRootCause,
                traceId,
              },
            }
          : {}),
        requestId,
      },
      { status: 500 }
    )
  }
}
