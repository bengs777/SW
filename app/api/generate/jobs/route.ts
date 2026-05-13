import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { log } from "@/lib/logging"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { byteSize, generationRequestHash, previewContextAudit } from "@/lib/services/generation-job-request.service"
import { ModelConfigService } from "@/lib/services/model-config.service"

export const runtime = "nodejs"
const routeRuntime: string = runtime

const CreateJobSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().trim().min(1).max(12_000),
  model: z.string().min(1),
  provider: z.string().optional(),
  plan: z.array(z.string()).optional(),
  promptLanguage: z.enum(["id", "en"]).optional().default("id"),
  collaborationMode: z.string().trim().max(80).optional(),
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

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  let requestId = "unassigned"
  let traceId = requestId
  let currentStage = "route_start"
  let failedStage: string | null = null
  let payloadSize = 0
  let previewContextSize = 0
  let hashCreated = false
  let dbCreated = false
  let enqueueSuccess = false
  let requestHash: string | null = null
  let body: unknown = null

  const auditSummary = (error?: unknown) => {
    const summary = {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
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
    })
    const summary = auditSummary(error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        stage,
        retryable,
        requestId,
        probableRootCause: summary.probableRootCause,
      },
      { status }
    )
  }

  try {
  requestId = request.headers.get("x-request-id") || randomUUID()
  traceId = request.headers.get("x-vercel-id") || requestId
  currentStage = "request_received"

  logStage("request_received", true, {
    requestId,
    traceId,
    runtime: routeRuntime,
    runtimeCompatibility: routeRuntime === "edge" ? "risk" : "nodejs_ok",
  })

  if (routeRuntime === "edge") {
    console.warn("[JOB_RUNTIME_COMPATIBILITY_RISK]", {
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
    console.error("[AUTH_FATAL]", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    })
    throw error
  }
  currentStage = "auth_success"
  logEarlyStage("auth_success", requestId)
  const email = session?.user?.email

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
    console.error("[BODY_PARSE_FATAL]", {
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
    console.error("[JOB_FATAL]", {
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
    console.error("[PREVIEW_CONTEXT_SERIALIZATION_FAILED]", {
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

  console.info("[HASH_AUDIT]", {
    hasPreviewContext: previewAudit.hasPreviewContext,
    activeFile: previewAudit.activeFile,
    diagnosticsCount: previewAudit.diagnosticsCount,
    selectedPathsCount: previewAudit.selectedPathsCount,
  })
  console.info("[PAYLOAD_SIZE_AUDIT]", {
    payloadSize,
    previewContextSize,
    diagnosticsCount: previewAudit.diagnosticsCount,
    filesCount: previewAudit.filesCount,
    payloadWarning: payloadSize > 500 * 1024,
    previewContextWarning: previewContextSize > 250 * 1024,
  })
  if (payloadSize > 500 * 1024 || previewContextSize > 250 * 1024) {
    console.warn("[JOB_PAYLOAD_SIZE_WARNING]", {
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

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found", requestId }, { status: 404 })
  }

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
    console.info("[JOB_AUDIT_SUMMARY]", {
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
    return NextResponse.json({
      error: "Too many active generation jobs. Wait for an existing job to finish before starting another.",
      requestId,
      activeGenerationCount,
      limit: env.aiMaxConcurrentGenerations,
    }, { status: 429 })
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
    console.info("[JOB_DB_CREATE]", {
      stage: "db_job_creation",
      success: false,
      requestId,
      projectId: project.id,
      userId: user.id,
      requestHash,
      cost: pricing.estimatedCost,
    })
    const reservation = await BillingService.reserveGenerationJob({
      userId: user.id,
      projectId: project.id,
      prompt: parsed.data.prompt,
      modelConfigId: modelConfig.id,
      model: modelConfig.key,
      provider: "swift",
      cost: pricing.estimatedCost,
      idempotencyKey: parsed.data.idempotencyKey,
      requestHash,
      plan: parsed.data.plan,
      context: {
        requestId,
        traceId,
        requestHash,
        requestedModel: parsed.data.model,
        routedModel: routingDecision.modelName,
        routing: {
          classification: routingDecision.classification,
          layer: routingDecision.layer,
          reason: routingDecision.reason,
        },
      },
    })
    const { job, usageLog } = reservation
    usageLogId = usageLog.id
    jobId = job.id
    dbCreated = true
    console.info("[JOB_DB_CREATE]", {
      stage: "db_job_creation",
      success: true,
      requestId,
      jobId,
      usageLogId,
      requestHash,
    })
    const queueId = parsed.data.idempotencyKey
      ? ["generation", user.id, project.id, parsed.data.idempotencyKey].join(":")
      : ["generation", user.id, project.id, requestHash].join(":")

    currentStage = "queue_enqueue"
    console.info("[QUEUE_ENQUEUE]", {
      stage: "queue_enqueue",
      success: false,
      requestId,
      jobId,
      queueId,
    })
    const queueJob = await enqueueGenerationTask(
      {
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
        previewContext: parsed.data.previewContext,
        attachments: parsed.data.attachments,
      },
      {
        jobId: queueId,
      }
    )

    if (!queueJob) {
      throw new Error("Generation queue is unavailable")
    }
    enqueueSuccess = true
    console.info("[QUEUE_ENQUEUE]", {
      stage: "queue_enqueue",
      success: true,
      requestId,
      jobId,
      queueJobId: queueJob.id || job.id,
    })

    await GenerationJobService.attachQueueJob(job.id, queueJob.id || job.id)
    const publicJob = await GenerationJobService.findById(job.id)

    currentStage = "response_return"
    console.info("[JOB_AUDIT_SUMMARY]", {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      enqueueSuccess,
      probableRootCause: "none_job_created_and_enqueued",
    })
    logStage("response_return", true, {
      requestId,
      traceId,
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
      billing: {
        usageLogId,
        reservedCost: pricing.estimatedCost,
      },
    }, {
      status: 202,
      headers: { "X-Request-Id": requestId },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue generation"
    const failureStage = currentStage === "queue_enqueue" ? "queue_enqueue" : "db_job_creation"
    failedStage = failureStage
    if (failureStage === "queue_enqueue") {
      console.error("[QUEUE_ENQUEUE_FAILED]", {
        stage: failureStage,
        success: false,
        requestId,
        jobId,
        usageLogId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      })
    } else {
      console.error("[JOB_DB_CREATE_FAILED]", {
        stage: failureStage,
        success: false,
        requestId,
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
        console.info("[JOB_AUDIT_SUMMARY]", {
          failedStage,
          payloadSize,
          hashCreated,
          dbCreated,
          enqueueSuccess,
          probableRootCause: "database_unique_constraint_deduped_existing_job",
        })
        logStage("response_return", true, {
          requestId,
          traceId,
          jobId: existing.id,
        })
        return NextResponse.json({
          job: GenerationJobService.toPublicJob(existing),
          idempotent: true,
          requestId,
        }, {
          status: 202,
          headers: { "X-Request-Id": requestId },
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
    return NextResponse.json(
      {
        error: message,
        stage: failureStage,
        retryable: status !== 402,
        requestId,
        probableRootCause: summary.probableRootCause,
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
    })
    const summary = auditSummary(error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        stage,
        requestId,
        probableRootCause: summary.probableRootCause,
      },
      { status: 500 }
    )
  }
}
