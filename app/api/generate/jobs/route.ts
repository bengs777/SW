import { NextRequest, NextResponse } from "next/server"
import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { normalizePreviewContext } from "@/lib/ai/preview-context"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
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

function stableJson(value: unknown): string {
  if (typeof value === "undefined") {
    return "null"
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
}

function byteSize(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 0
  }
}

function objectKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : []
}

function previewContextAudit(value: unknown) {
  const context = normalizePreviewContext(value)
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  const files = Array.isArray(raw?.files) ? raw.files : []
  const previewFiles = Array.isArray(raw?.previewFiles) ? raw.previewFiles : []
  const diagnostics = raw && Array.isArray(raw.diagnostics) ? raw.diagnostics : []
  const selectedPaths = new Set<string>()

  if (context?.activeFilePath) {
    selectedPaths.add(context.activeFilePath)
  }

  for (const file of [...files, ...previewFiles]) {
    if (file && typeof file === "object" && "isActive" in file && (file as { isActive?: unknown }).isActive) {
      const path = (file as { path?: unknown }).path
      if (typeof path === "string") {
        selectedPaths.add(path)
      }
    }
  }

  return {
    normalized: context,
    hasPreviewContext: Boolean(value),
    keys: objectKeys(value),
    activeFile: context?.activeFilePath || null,
    diagnosticsCount: diagnostics.length,
    filesCount: files.length,
    previewFilesCount: previewFiles.length,
    selectedPathsCount: selectedPaths.size,
    sizeBytes: byteSize(value ?? null),
  }
}

function logStage(stage: string, success: boolean, detail?: Record<string, unknown>) {
  console.info("[JOB_STAGE]", {
    stage,
    success,
    ...(detail || {}),
  })
}

function logFatal(stage: string, error: unknown, detail?: Record<string, unknown>) {
  console.error("[JOB_FATAL]", {
    stage,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(detail || {}),
  })
}

function probableRootCause(stage: string, error?: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
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

function generationRequestHash(input: z.infer<typeof CreateJobSchema>) {
  const now = new Date()
  const dedupeBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`
  const payload = {
    dedupeBucket,
    projectId: input.projectId,
    prompt: input.prompt.replace(/\s+/g, " ").trim(),
    model: input.model,
    provider: input.provider || "swift",
    promptLanguage: input.promptLanguage,
    collaborationMode: input.collaborationMode || "",
    previewContext: createHash("sha256").update(stableJson(input.previewContext || null)).digest("hex"),
    attachments: input.attachments.map((attachment) =>
      createHash("sha256").update(stableJson(attachment)).digest("hex")
    ),
  }

  return createHash("sha256").update(stableJson(payload)).digest("hex")
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const requestId = request.headers.get("x-request-id") || randomUUID()
  const traceId = request.headers.get("x-vercel-id") || requestId
  let currentStage = "request_received"
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
    console.info("[JOB_AUDIT_SUMMARY]", summary)
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

  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    auditSummary()
    return NextResponse.json({ error: "Authentication required", requestId }, { status: 401 })
  }

  currentStage = "request_body_parse"
  logStage("request_body_parse", false, { requestId })
  try {
    body = await request.json()
    payloadSize = byteSize(body)
    logStage("request_body_parse", true, { requestId, payloadSize })
  } catch (error) {
    return fatalResponse("request_body_parse", error, 400, false)
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

    auditSummary(error)

    const status = /insufficient balance/i.test(message) ? 402 : 503
    return NextResponse.json(
      {
        error: message,
        stage: failureStage,
        retryable: status !== 402,
        requestId,
      },
      { status }
    )
  }
}
