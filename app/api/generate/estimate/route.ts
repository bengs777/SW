import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { ModelConfigService } from "@/lib/services/model-config.service"
import type { PromptAttachment } from "@/lib/types"
import { z } from "zod"

const MAX_PROMPT_LENGTH = 12000
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE_BYTES = 3 * 1024 * 1024
const MAX_ATTACHMENT_CONTEXT_CHARS = 20000

const EstimateSchema = z.object({
  prompt: z.string().min(1),
  selectedModel: z.string().min(1),
  projectId: z.string().min(1).optional(),
  attachments: z.array(
    z.object({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(180),
      originalName: z.string().max(180).optional(),
      mimeType: z.string().max(120).optional().default("application/octet-stream"),
      size: z.number().int().nonnegative().max(MAX_ATTACHMENT_SIZE_BYTES),
      kind: z.enum(["image", "text", "binary"]),
      content: z.string().min(1),
      assetId: z.string().max(100).optional(),
      storageBucket: z.string().max(120).optional(),
      storagePath: z.string().max(500).optional(),
      uploadedAt: z.string().optional(),
      uploadedByUserId: z.string().max(100).optional(),
    }).passthrough()
  ).max(MAX_ATTACHMENTS).optional().default([]),
})

function estimateTokens(prompt: string) {
  // Lightweight heuristic: 1 token ~= 4 chars plus small system overhead.
  return Math.max(64, Math.ceil(prompt.length / 4) + 120)
}

export async function POST(request: NextRequest) {
  const session = await auth()
  const email = session?.user?.email

  if (!email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  try {
    const raw = await request.json()
    const body = await EstimateSchema.parseAsync(raw)
    const prompt = body.prompt.trim()
    const attachments = normalizeAttachments(body.attachments)
    const promptWithAttachments = appendAttachmentsToPrompt(prompt, attachments)
    const selectedModel = body.selectedModel.trim()

    if (promptWithAttachments.length > MAX_PROMPT_LENGTH) {
      return NextResponse.json(
        {
          error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`,
          maxLength: MAX_PROMPT_LENGTH,
          currentLength: promptWithAttachments.length,
        },
        { status: 400 }
      )
    }

    const [modelConfig, user] = await Promise.all([
      ModelConfigService.getActiveModelByKey(selectedModel),
      prisma.user.findUnique({
        where: { email },
        select: { balance: true },
      }),
    ])

    if (!modelConfig) {
      return NextResponse.json({ error: "Selected model is not available" }, { status: 403 })
    }

    if (!user) {
      return NextResponse.json({ error: "Authenticated user not found" }, { status: 404 })
    }

    const estimatedTokens = estimateTokens(promptWithAttachments)
    const estimatedCost = modelConfig.price
    const remainingBalance = user.balance - estimatedCost

    return NextResponse.json({
      model: modelConfig.key,
      provider: modelConfig.provider,
      estimatedTokens,
      estimatedCost,
      currentBalance: user.balance,
      remainingBalance,
      canAfford: remainingBalance >= 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to estimate request"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function normalizeAttachments(attachments: PromptAttachment[] | undefined): PromptAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return []
  }

  return attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => ({
    ...attachment,
    name: attachment.name.trim().slice(0, 180),
    mimeType: (attachment.mimeType || "application/octet-stream").trim().slice(0, 120),
    content: attachment.content || "",
  }))
}

function appendAttachmentsToPrompt(prompt: string, attachments: PromptAttachment[]) {
  if (attachments.length === 0) {
    return prompt
  }

  let usedChars = 0
  const lines = attachments
    .map((attachment, index) => {
      if (usedChars >= MAX_ATTACHMENT_CONTEXT_CHARS) {
        return ""
      }

      const header = `Attachment ${index + 1}: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`
      const body =
        attachment.kind === "image"
          ? attachment.content.slice(0, 1400)
          : attachment.content.slice(0, 5000)

      usedChars += body.length
      return `${header}\n${body}`
    })
    .filter(Boolean)
    .join("\n\n")

  if (!lines) {
    return prompt
  }

  return `${prompt}\n\nAdditional user attachments:\n${lines}`
}
