import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { routeModelForRequest } from "@/lib/ai/generation-pipeline"
import { calculateModelRequestPrice } from "@/lib/ai/pricing"
import { enqueueGenerationTask } from "@/lib/queue/generation-queue"
import { enforceAiUsageRateLimit } from "@/lib/security/rate-limit"
import { BillingService } from "@/lib/services/billing.service"
import { GenerationJobService } from "@/lib/services/generation-job.service"
import { ModelConfigService } from "@/lib/services/model-config.service"

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

export async function POST(request: NextRequest) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = await CreateJobSchema.safeParseAsync(body)

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid generation job payload" }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
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
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  try {
    await enforceAiUsageRateLimit(user.id)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rate limit exceeded" },
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
    return NextResponse.json({ error: "Selected model is not available" }, { status: 403 })
  }

  const pricing = calculateModelRequestPrice({
    modelKey: modelConfig.key,
    modelName: modelConfig.modelName,
    prompt: parsed.data.prompt,
  })

  let usageLogId: string | null = null
  let jobId: string | null = null

  try {
    const usageLog = await BillingService.reserveBalance(
      user.id,
      modelConfig.id,
      modelConfig.key,
      "swift",
      parsed.data.prompt,
      pricing.estimatedCost
    )
    usageLogId = usageLog.id

    const job = await GenerationJobService.create({
      userId: user.id,
      projectId: project.id,
      prompt: parsed.data.prompt,
      model: modelConfig.key,
      provider: "swift",
      plan: parsed.data.plan,
      context: {
        requestedModel: parsed.data.model,
        routedModel: routingDecision.modelName,
        routing: {
          classification: routingDecision.classification,
          layer: routingDecision.layer,
          reason: routingDecision.reason,
        },
        billing: {
          usageLogId,
          reservedCost: pricing.estimatedCost,
          modelConfigId: modelConfig.id,
        },
      },
    })
    jobId = job.id
    const queueId = parsed.data.idempotencyKey
      ? ["generation", user.id, project.id, parsed.data.idempotencyKey].join(":")
      : job.id

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

    return NextResponse.json({
      job: GenerationJobService.toPublicJob(publicJob || job),
      billing: {
        usageLogId,
        reservedCost: pricing.estimatedCost,
      },
    }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue generation"

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

    const status = /insufficient balance/i.test(message) ? 402 : 503
    return NextResponse.json(
      { error: message },
      { status }
    )
  }
}
