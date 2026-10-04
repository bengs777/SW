import { after, NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { users, projects, generationJobs, generationEvents, usageLogs } from "@/lib/db/schema"
import { eq, and, lt, inArray } from "drizzle-orm"
import { env } from "@/lib/env"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { COLLABORATION_MODES, isMutatingCollaborationMode } from "@/lib/ai/collaboration-mode"
import type { GenerationQueuePayload } from "@/lib/queue/generation-queue"
import { processGenerationPayload } from "@/lib/workers/generation-worker"
import { enforceAiUsageRateLimit, releaseAiUsageQuota } from "@/lib/security/rate-limit"
import { log } from "@/lib/logging"
import { createCorrelationIds, traceExecution } from "@/lib/observability/execution-tracer"
import { warnIfSlow } from "@/lib/observability/performance-monitor"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { byteSize, generationRequestHash, previewContextAudit } from "@/lib/services/generation-job-request.service"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { BillingService } from "@/lib/services/billing.service"
import { OrchestrationRuntimeService } from "@/lib/services/orchestration-runtime.service"
import { assertFeatureEnabled } from "@/lib/feature-flags"
import { getProjectAccess } from "@/lib/auth/project-access"
import { timeoutConfig } from "@/lib/timeouts"

export const runtime = "nodejs"
export const maxDuration = 300
const routeRuntime: string = runtime

const DIRECT_FALLBACK = "direct_openrouter_free"
const DIRECT_PROVIDER = "openrouter"
const ACTIVE_JOB_STATUSES = ["queued", "running", "processing", "retrying", "stalled", "orphaned"]
const STUCK_JOB_STATUSES = ["queued", "running", "cancelling"]
const STUCK_THRESHOLD_MS = 5 * 60_000

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
  log("info", "generation_direct_stage", {
    stage,
    success,
    ...(detail || {}),
  })
}

function logEarlyStage(stage: string, requestId: string, detail?: Record<string, unknown>) {
  log("info", "generation_direct_stage", {
    stage,
    requestId,
    ...(detail || {}),
  })
}

function logFatal(stage: string, error: unknown, detail?: Record<string, unknown>) {
  log("error", "generation_direct_fatal", {
    stage,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(detail || {}),
  })
}

function probableRootCause(stage: string, error?: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  if (
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
  if (stage === "rate_limit") return "AI usage rate limit rejected the direct fallback request."
  if (stage === "model_config") return "Routed model is not active in model configuration."
  if (stage === "db_job_creation") return "Direct fallback usage log or generation job insert failed."
  if (stage === "response_return") return "Response serialization failed after job creation."
  return "Unknown route failure; inspect stack and previous stage logs."
}

function developerGenerationFailureMessage(input: {
  stage: string
  probableRootCause: string
  traceId: string
}) {
  return [
    "Direct generation failed during:",
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
  const featureCheck = assertFeatureEnabled("enableAiGenerate", "AI generation")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

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
  let executionScheduled = false
  let developerDiagnosticsAllowed = false
  let body: unknown = null
  let quotaUserId: string | null = null
  let quotaUsageLogId: string | null = null

  // Returns the daily generation quota reserved for this request once it is
  // clear that no generation will run for it. Refunding the usage log also
  // releases the Redis day counter, so failures never burn the free quota.
  const releaseDirectQuota = async (errorMessage: string) => {
    const userId = quotaUserId
    const usageLogId = quotaUsageLogId
    quotaUserId = null
    quotaUsageLogId = null

    if (!userId) return

    if (usageLogId) {
      await BillingService.refundReservation(usageLogId, userId, 0, errorMessage).catch(() => null)
      return
    }

    await releaseAiUsageQuota(userId).catch(() => null)
  }

  const auditSummary = (error?: unknown, outcome?: string) => {
    const summary = {
      failedStage,
      payloadSize,
      hashCreated,
      dbCreated,
      executionScheduled,
      probableRootCause: outcome || probableRootCause(failedStage || currentStage, error),
    }
    log("info", "generation_direct_audit_summary", summary)
    return summary
  }

  const fatalResponse = async (stage: string, error: unknown, status = 500, retryable = true) => {
    failedStage = stage
    await releaseDirectQuota(error instanceof Error ? error.message : String(error || "generation request failed"))
    logFatal(stage, error, {
      requestId,
      traceId,
      payloadSize,
      previewContextSize,
      hashCreated,
      dbCreated,
      executionScheduled,
    })
    const summary = auditSummary(error)
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
      fallback: DIRECT_FALLBACK,
    })
    logStage("request_received", true, {
      requestId,
      correlationId,
      traceId,
      executionChainId,
      runtime: routeRuntime,
      fallback: DIRECT_FALLBACK,
    })

    currentStage = "auth_start"
    logEarlyStage("auth_start", requestId)
    let session: { email?: string | null } | null
    try {
      session = await getSession()
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
    const email = session?.email
    developerDiagnosticsAllowed = Boolean(
      email &&
        env.devOwnerEmail &&
        email.trim().toLowerCase() === env.devOwnerEmail.trim().toLowerCase()
    )

    if (!email) {
      auditSummary()
      return NextResponse.json(
        { error: "Authentication required", stage: "auth_start", retryable: false, requestId },
        { status: 401 }
      )
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
      log("error", "direct_payload_validation_failed", {
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

    if (parsed.data.collaborationMode === "edit" || parsed.data.collaborationMode === "fix") {
      const editFeatureCheck = assertFeatureEnabled("enableAiEdit", "AI edit")
      if (editFeatureCheck) {
        return NextResponse.json({ error: editFeatureCheck.error }, { status: editFeatureCheck.status })
      }
    }

    if (!isMutatingCollaborationMode(parsed.data.collaborationMode)) {
      log("warn", "direct_generation_non_mutating_mode_rejected", {
        requestId,
        collaborationMode: parsed.data.collaborationMode,
        projectId: parsed.data.projectId,
      })
      return NextResponse.json(
        {
          error: "collaboration_mode_not_generating",
          message:
            "Ask and review modes never run direct generation. Send them to /api/ai/answer instead.",
          mode: parsed.data.collaborationMode,
        },
        { status: 409 }
      )
    }

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
    logStage("previewContext_normalization", true, {
      requestId,
      hasPreviewContext: previewAudit.hasPreviewContext,
      normalized: Boolean(previewAudit.normalized),
      previewContextSize,
    })

    const userLookupStartedAt = Date.now()
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    })
    developerDiagnosticsAllowed = developerDiagnosticsAllowed || Boolean(user?.isDeveloperAccount)
    const userLookupDurationMs = Date.now() - userLookupStartedAt
    warnIfSlow("db", userLookupDurationMs, { operation: "user.findFirst", requestId })

    if (!user) {
      return NextResponse.json(
        { error: "Authenticated user not found", stage: "user_lookup", retryable: false, requestId },
        { status: 404 }
      )
    }

    const projectLookupStartedAt = Date.now()
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, parsed.data.projectId),
    })
    const projectLookupDurationMs = Date.now() - projectLookupStartedAt
    warnIfSlow("db", projectLookupDurationMs, { operation: "project.findFirst", requestId })

    if (!project) {
      auditSummary()
      return NextResponse.json(
        { error: "Project not found", stage: "project_lookup", retryable: false, requestId },
        { status: 404 }
      )
    }

    const projectAccess = await getProjectAccess(project.id, { userId: user.id, email })
    if (!projectAccess) {
      auditSummary()
      return NextResponse.json(
        { error: "Project not found", stage: "project_lookup", retryable: false, requestId },
        { status: 404 }
      )
    }

    currentStage = "request_hash_creation"
    logStage("request_hash_creation", false, {
      requestId,
      hasPreviewContext: previewAudit.hasPreviewContext,
      stableObjectOrdering: true,
    })
    let rawRequestHash: string
    try {
      rawRequestHash = generationRequestHash(parsed.data)
      hashCreated = true
      logStage("request_hash_creation", true, {
        requestId,
        requestHash: rawRequestHash,
        serialization: "stableJson_sorted_keys",
      })
    } catch (error) {
      return fatalResponse("request_hash_creation", error, 500, true)
    }

    const clientKey = parsed.data.idempotencyKey || null
    const directIdempotencyKey = clientKey ? `direct:${clientKey}` : null
    const directRequestHash = clientKey
      ? `direct:${rawRequestHash}:${clientKey}`
      : `direct:${rawRequestHash}`

    currentStage = "dedupe_lookup"
    logStage("dedupe_lookup", false, { requestId, requestHash: rawRequestHash })
    const activePrimaryJob = await GenerationJobService.findIdempotentJob({
      userId: user.id,
      projectId: project.id,
      idempotencyKey: clientKey,
      requestHash: rawRequestHash,
    })
    const reusedActivePrimaryJob =
      activePrimaryJob &&
      ACTIVE_JOB_STATUSES.includes(activePrimaryJob.status) &&
      !activePrimaryJob.cancelRequested
        ? activePrimaryJob
        : null
    if (reusedActivePrimaryJob) {
      auditSummary(undefined, "none_reused_active_primary_job")
      logStage("response_return", true, {
        requestId,
        traceId,
        jobId: reusedActivePrimaryJob.id,
        reusedActiveJob: true,
      })
      return NextResponse.json(
        {
          job: GenerationJobService.toPublicJob(reusedActivePrimaryJob),
          idempotent: true,
          reusedActiveJob: true,
          fallback: DIRECT_FALLBACK,
          requestId,
          correlationId,
          traceId,
          executionChainId,
          billing: {
            usageLogId: null,
            reservedCost: 0,
            mode: "audit_only",
          },
        },
        {
          status: 202,
          headers: {
            "X-Request-Id": requestId,
            "X-Correlation-Id": correlationId,
            "X-Trace-Id": traceId,
            "X-Execution-Chain-Id": executionChainId,
          },
        }
      )
    }

    const existingDirectJob = await GenerationJobService.findIdempotentJob({
      userId: user.id,
      projectId: project.id,
      idempotencyKey: directIdempotencyKey,
      requestHash: directRequestHash,
    })
    logStage("dedupe_lookup", true, {
      requestId,
      requestHash: rawRequestHash,
      existingJobId: existingDirectJob?.id || null,
      activePrimaryJobId: activePrimaryJob?.id || null,
    })

    if (existingDirectJob) {
      auditSummary(undefined, "none_deduped_existing_direct_job")
      logStage("response_return", true, {
        requestId,
        traceId,
        jobId: existingDirectJob.id,
      })
      return NextResponse.json(
        {
          job: GenerationJobService.toPublicJob(existingDirectJob),
          idempotent: true,
          fallback: DIRECT_FALLBACK,
          requestId,
          correlationId,
          traceId,
          executionChainId,
          billing: {
            usageLogId: null,
            reservedCost: 0,
            mode: "audit_only",
          },
        },
        {
          status: 202,
          headers: {
            "X-Request-Id": requestId,
            "X-Correlation-Id": correlationId,
            "X-Trace-Id": traceId,
            "X-Execution-Chain-Id": executionChainId,
          },
        }
      )
    }

    const activeGenerationCount = await GenerationJobService.countActiveForUser(user.id)
    if (activeGenerationCount >= env.aiMaxConcurrentGenerations) {
      const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS)
      const stuckJobs = await db.select({ id: generationJobs.id })
        .from(generationJobs)
        .where(and(
          eq(generationJobs.userId, user.id),
          inArray(generationJobs.status, STUCK_JOB_STATUSES),
          lt(generationJobs.updatedAt, stuckCutoff)
        ))
        .limit(5)

      if (stuckJobs.length > 0) {
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
      } else {
        auditSummary(undefined, "blocked_active_generation_limit")
        return NextResponse.json(
          {
            error: "Too many active generation jobs. Wait for an existing job to finish before starting another.",
            stage: "concurrency_limit",
            retryable: true,
            requestId,
            activeGenerationCount,
            limit: env.aiMaxConcurrentGenerations,
          },
          { status: 429 }
        )
      }
    }

    try {
      await enforceAiUsageRateLimit(user.id)
    } catch (error) {
      failedStage = "rate_limit"
      auditSummary(error)
      log("warn", "generation_direct_rate_limited", {
        requestId,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
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
    quotaUserId = user.id

    const routingDecision = routeModelForRequest({
      prompt: parsed.data.prompt,
      purpose: "generate",
      attachmentCount: parsed.data.attachments.length,
    })
    const modelConfig = await ModelConfigService.getActiveModelByKey(routingDecision.modelName)

    if (!modelConfig) {
      failedStage = "model_config"
      await releaseDirectQuota("Selected model is not available")
      auditSummary()
      return NextResponse.json(
        { error: "Selected model is not available", stage: "model_config", retryable: false, requestId },
        { status: 403 }
      )
    }

    currentStage = "db_job_creation"
    log("info", "direct_db_create", {
      stage: "db_job_creation",
      success: false,
      requestId,
      projectId: project.id,
      userId: user.id,
      requestHash: rawRequestHash,
      directRequestHash,
      cost: 0,
      fallback: DIRECT_FALLBACK,
    })

    let usageLog: typeof usageLogs.$inferSelect | null = null
    let job: typeof generationJobs.$inferSelect | null = null
    try {
      const usageLogResult = await db.insert(usageLogs).values({
        id: randomUUID(),
        userId: user.id,
        modelConfigId: modelConfig.id,
        model: modelConfig.key,
        provider: DIRECT_PROVIDER,
        cost: 0,
        prompt: parsed.data.prompt,
        status: "direct",
      }).returning()
      usageLog = usageLogResult[0]
      quotaUsageLogId = usageLog.id

      try {
        const jobResult = await db.insert(generationJobs).values({
          id: randomUUID(),
          userId: user.id,
          projectId: project.id,
          prompt: parsed.data.prompt,
          model: modelConfig.key,
          provider: DIRECT_PROVIDER,
          idempotencyKey: directIdempotencyKey,
          requestHash: directRequestHash,
          status: "queued",
          orchestrationState: "queued",
          stage: "queued",
          label: "Prompt diterima",
          progress: 0,
          maxRetries: 2,
          traceId,
          planJson: parsed.data.plan ? JSON.stringify(parsed.data.plan) : null,
          contextJson: JSON.stringify({
            requestId,
            traceId,
            correlationId,
            executionChainId,
            requestHash: rawRequestHash,
            requestedModel: parsed.data.model,
            routedModel: routingDecision.modelName,
            routing: {
              classification: routingDecision.classification,
              layer: routingDecision.layer,
              reason: routingDecision.reason,
            },
            fallback: DIRECT_FALLBACK,
            billing: {
              usageLogId: usageLog?.id || null,
              reservedCost: 0,
              mode: "audit_only",
            },
          }),
        }).returning()
        job = jobResult[0]
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message)) {
          const existing = await GenerationJobService.findIdempotentJob({
            userId: user.id,
            projectId: project.id,
            idempotencyKey: directIdempotencyKey,
            requestHash: directRequestHash,
          })
          if (existing) {
            dbCreated = true
            auditSummary(undefined, "database_unique_constraint_deduped_existing_direct_job")
            logStage("response_return", true, {
              requestId,
              traceId,
              jobId: existing.id,
              uniqueConstraintDeduped: true,
            })
            // This request wrote an orphan usage log: the job that will actually
            // run already carries its own billing record, so release ours.
            await releaseDirectQuota("Duplicate direct generation request deduped")
            return NextResponse.json(
              {
                job: GenerationJobService.toPublicJob(existing),
                idempotent: true,
                fallback: DIRECT_FALLBACK,
                requestId,
                correlationId,
                traceId,
                executionChainId,
                billing: {
                  usageLogId: usageLog?.id || null,
                  reservedCost: 0,
                  mode: "audit_only",
                },
              },
              {
                status: 202,
                headers: {
                  "X-Request-Id": requestId,
                  "X-Correlation-Id": correlationId,
                  "X-Trace-Id": traceId,
                  "X-Execution-Chain-Id": executionChainId,
                },
              }
            )
          }
        }
        throw error
      }
    } catch (error) {
      logFatal("db_job_creation", error, {
        requestId,
        correlationId,
        traceId,
        usageLogId: usageLog?.id || null,
        requestHash: rawRequestHash,
      })
      auditSummary(error)
      return fatalResponse("db_job_creation", error, 503, true)
    }

    dbCreated = true
    const createdJob = job
    const createdUsageLog = usageLog
    if (!createdJob || !createdUsageLog) {
      return fatalResponse("db_job_creation", new Error("Direct fallback row creation returned no rows"), 503, true)
    }

    try {
      await db.insert(generationEvents).values({
        id: randomUUID(),
        jobId: createdJob.id,
        traceId,
        sequence: 1,
        type: "job.created",
        eventType: "job.created",
        stage: "queued",
        status: "queued",
        message: "Generation job queued",
        dataJson: JSON.stringify({
          projectId: project.id,
          provider: DIRECT_PROVIDER,
          model: modelConfig.key,
          usageLogId: createdUsageLog.id,
          fallback: DIRECT_FALLBACK,
        }),
      })
    } catch (error) {
      log("warn", "generation_direct_event_create_failed", {
        requestId,
        jobId: createdJob.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    await GenerationJobService.attachQueueJob(createdJob.id, `direct:${createdJob.id}`).catch((error) => {
      log("warn", "generation_direct_attach_queue_job_failed", {
        requestId,
        jobId: createdJob.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    await OrchestrationRuntimeService.persistDurableState({
      jobId: createdJob.id,
      orchestrationState: "queued",
      currentPhase: "queued",
      generationProgress: 0,
      queueAttempt: 0,
      traceId,
      recoveryState: {
        state: "queued",
        recoveryEligible: false,
      },
    }).catch(() => null)

    const generationPayload: GenerationQueuePayload = {
      jobId: createdJob.id,
      userId: user.id,
      projectId: project.id,
      prompt: parsed.data.prompt,
      model: modelConfig.key,
      provider: DIRECT_PROVIDER,
      usageLogId: createdUsageLog.id,
      reservedCost: 0,
      modelConfigId: modelConfig.id,
      promptLanguage: parsed.data.promptLanguage,
      collaborationMode: parsed.data.collaborationMode,
      idempotencyKey: directIdempotencyKey || undefined,
      requestHash: directRequestHash,
      correlationId,
      traceId,
      executionChainId,
      previewContext: parsed.data.previewContext,
      attachments: parsed.data.attachments,
    }

    traceExecution({
      taskId: createdJob.id,
      sessionId: user.id,
      agentType: "generation",
      correlationId,
      traceId,
      executionChainId,
    }, "generation_started", {
      projectId: project.id,
      model: modelConfig.key,
      fallback: DIRECT_FALLBACK,
    })
    log("info", "generation_direct_started", {
      event: "generation_direct_started",
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId: createdJob.id,
      projectId: project.id,
      userId: user.id,
      startedAt: new Date(startedAt).toISOString(),
      requestHash: rawRequestHash,
      directRequestHash,
      fallback: DIRECT_FALLBACK,
    })

    executionScheduled = true
    after(async () => {
      const watchdogMs = timeoutConfig.generationJobMs + 120_000
      const watchdogHandle = setTimeout(() => {
        log("warn", "generation_direct_execution_watchdog_timeout", {
          requestId,
          correlationId,
          traceId,
          jobId: createdJob.id,
          watchdogMs,
        })
      }, watchdogMs)
      try {
        await processGenerationPayload(generationPayload, `direct:${createdJob.id}`)
        log("info", "generation_direct_execution_completed", {
          requestId,
          correlationId,
          traceId,
          jobId: createdJob.id,
          projectId: project.id,
          fallback: DIRECT_FALLBACK,
          durationMs: Date.now() - startedAt,
        })
      } catch (error) {
        log("error", "generation_direct_execution_failed", {
          requestId,
          correlationId,
          traceId,
          jobId: createdJob.id,
          projectId: project.id,
          fallback: DIRECT_FALLBACK,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      } finally {
        clearTimeout(watchdogHandle)
      }
    })

    currentStage = "response_return"
    auditSummary(undefined, "none_direct_job_created_and_execution_scheduled")
    logStage("response_return", true, {
      requestId,
      correlationId,
      traceId,
      executionChainId,
      jobId: createdJob.id,
      usageLogId: createdUsageLog.id,
      projectId: project.id,
      userId: user.id,
      requestHash: rawRequestHash,
      reservedCost: 0,
      fallback: DIRECT_FALLBACK,
      durationMs: Date.now() - startedAt,
    })

    return NextResponse.json(
      {
        job: GenerationJobService.toPublicJob(createdJob),
        idempotent: false,
        fallback: DIRECT_FALLBACK,
        requestId,
        correlationId,
        traceId,
        executionChainId,
        billing: {
          usageLogId: createdUsageLog.id,
          reservedCost: 0,
          mode: "audit_only",
        },
      },
      {
        status: 202,
        headers: {
          "X-Request-Id": requestId,
          "X-Correlation-Id": correlationId,
          "X-Trace-Id": traceId,
          "X-Execution-Chain-Id": executionChainId,
        },
      }
    )
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
      executionScheduled,
    })
    const summary = auditSummary(error)
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

    // Failed request: give the daily quota back when no usage log was written,
    // or refund the usage log so the worker path and this path stay idempotent.
    await releaseDirectQuota(safeError)

    return NextResponse.json(
      {
        error: safeError,
        ...(developerDiagnosticsAllowed || !isProduction
          ? {
              stage,
              probableRootCause: summary.probableRootCause,
              traceId,
            }
          : {}),
        retryable: true,
        requestId,
      },
      { status: 500 }
    )
  }
}
