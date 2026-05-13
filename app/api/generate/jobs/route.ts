import { NextRequest, NextResponse } from "next/server"
import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { log } from "@/lib/logging"

export const runtime = "nodejs"

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
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required", requestId }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = await CreateJobSchema.safeParseAsync(body)

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generation job payload", requestId }, { status: 400 })
  }

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
    return NextResponse.json({ error: "Project not found", requestId }, { status: 404 })
  }

  const requestHash = generationRequestHash(parsed.data)

  const existingJob = await GenerationJobService.findIdempotentJob({
    userId: user.id,
    projectId: project.id,
    idempotencyKey: parsed.data.idempotencyKey,
    requestHash,
  })

  if (existingJob) {
    log("info", "Generation request deduped", {
      requestId,
      traceId,
      jobId: existingJob.id,
      projectId: project.id,
      userId: user.id,
      requestHash,
      durationMs: Date.now() - startedAt,
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rate limit exceeded", requestId },
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
    const queueId = parsed.data.idempotencyKey
      ? ["generation", user.id, project.id, parsed.data.idempotencyKey].join(":")
      : ["generation", user.id, project.id, requestHash].join(":")

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

    await GenerationJobService.attachQueueJob(job.id, queueJob.id || job.id)
    const publicJob = await GenerationJobService.findById(job.id)
    log("info", "Generation request queued", {
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
        log("info", "Generation request deduped after unique constraint", {
          requestId,
          traceId,
          jobId: existing.id,
          projectId: project.id,
          userId: user.id,
          requestHash,
          durationMs: Date.now() - startedAt,
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

    log("error", "Generation request failed", {
      requestId,
      traceId,
      jobId,
      usageLogId,
      projectId: project.id,
      userId: user.id,
      requestHash,
      error: message,
      durationMs: Date.now() - startedAt,
    })

    const status = /insufficient balance/i.test(message) ? 402 : 503
    return NextResponse.json(
      { error: message, requestId },
      { status }
    )
  }
}
