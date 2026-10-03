import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getSession } from "@/auth"
import { db } from "@/lib/db/client"
import { users, projects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { assertFeatureEnabled } from "@/lib/feature-flags"
import { enforceUserRateLimit } from "@/lib/security/rate-limit"
import { ProviderRouter, SwiftProviderFailureError, type ProviderName } from "@/lib/ai/provider-router"
import { chooseModelForTask } from "@/lib/ai/model-router"
import { SWIFT_PROVIDER } from "@/lib/ai/swift-tiers"
import { ModelConfigService } from "@/lib/services/model-config.service"
import { normalizePreviewContext, appendPreviewContextToPrompt } from "@/lib/ai/preview-context"
import { log } from "@/lib/logging"

export const runtime = "nodejs"

const MAX_PROMPT_LENGTH = 12000
const MAX_CONTEXT_LENGTH = 30000
const ANSWER_TIMEOUT_MS = 45_000

const answerSchema = z.object({
  projectId: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().min(1).max(120).optional(),
  promptLanguage: z.enum(["id", "en"]).optional().default("id"),
  mode: z.enum(["ask", "review"]),
  previewContext: z.unknown().optional(),
})

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function resolveSessionUserId() {
  const session = await getSession()
  const userId = session?.userId

  if (userId) {
    return { session, userId }
  }

  const email = session?.email?.trim().toLowerCase()
  if (!email) {
    return { session, userId: null }
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  })

  return { session, userId: user?.id ?? null }
}

async function requireProjectMember(projectId: string, userId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return { ok: false as const, status: 404, error: "Project not found" }
  }

  return { ok: true as const, projectId, role: "member" as const }
}

function buildAnswerInstruction(mode: "ask" | "review", language: "id" | "en") {
  const replyLanguage = language === "id" ? "Bahasa Indonesia" : "English"

  if (mode === "review") {
    return [
      `User meminta review kode untuk project yang sedang dikerjakan di web app builder. Balas dalam ${replyLanguage}.`,
      "Beri daftar temuan terprioritas: bug fungsional, keamanan, performa, aksesibilitas, dan kode mati atau duplikat.",
      "Setiap temuan: sebutkan lokasi file bila ada di konteks, kenapa bermasalah, dan saran perbaikan singkat.",
      "Jangan mengubah atau membuat file. Jangan mengirim JSON, daftar file, atau blok kode besar.",
    ].join(" ")
  }

  return [
    "Kamu adalah Swift AI, asisten percakapan di dalam web app builder.",
    `Balas dalam ${replyLanguage}, ringkas dan natural.`,
    "Jangan mengirim JSON, daftar file, atau kode kecuali user secara eksplisit meminta implementasi.",
    "Jangan menyebut provider, nama model kompetitor, atau saran mengganti model.",
  ].join(" ")
}

export async function POST(req: NextRequest) {
  const { session, userId } = await resolveSessionUserId()

  if (!session || !userId) {
    log("warn", "ai-answer denied", { reason: "unauthorized" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const featureCheck = assertFeatureEnabled("enableAiChat", "AI chat")
  if (featureCheck) {
    return NextResponse.json({ error: featureCheck.error }, { status: featureCheck.status })
  }

  try {
    await enforceUserRateLimit(`ai-answer:${userId}`)
  } catch (error) {
    log("warn", "ai-answer rate limited", { userId })
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 429 })
  }

  const parsed = answerSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const { projectId, prompt, promptLanguage, mode } = parsed.data

  const access = await requireProjectMember(projectId, userId)
  if (!access.ok) {
    log("warn", "ai-answer denied", { userId, projectId, reason: access.error, status: access.status })
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  try {
    const previewContext = normalizePreviewContext(parsed.data.previewContext)
    const basePrompt = [
      buildAnswerInstruction(mode, promptLanguage),
      `Original prompt dari user:\n${prompt}`,
    ].join("\n\n")
    const fullPrompt = appendPreviewContextToPrompt(basePrompt, previewContext).slice(0, MAX_CONTEXT_LENGTH)

    const modelConfig = parsed.data.model
      ? await ModelConfigService.getActiveModelByKey(parsed.data.model).catch(() => null)
      : null
    const routed = chooseModelForTask("generate", { prompt })
    const modelName = modelConfig?.modelName || routed.modelName
    const provider: ProviderName = modelConfig?.provider || SWIFT_PROVIDER

    const response = await ProviderRouter.generate({
      provider,
      modelName,
      prompt: fullPrompt,
      mode: "chat",
      promptLanguage,
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    })

    log("info", "ai-answer completed", { userId, projectId, mode, model: response.modelUsed })
    return NextResponse.json({
      answer: response.message,
      model: response.modelUsed,
      mode,
    })
  } catch (error) {
    if (error instanceof SwiftProviderFailureError) {
      log("error", "ai-answer provider failed", { userId, projectId, mode, error: getErrorMessage(error) })
      return NextResponse.json(
        { error: "Swift sedang sibuk menjawab pertanyaan. Coba lagi sebentar." },
        { status: 502 }
      )
    }

    if (error instanceof Error && /timeout|aborted/i.test(error.message)) {
      return NextResponse.json(
        { error: "Waktu jawaban habis. Coba kirim ulang pertanyaannya." },
        { status: 504 }
      )
    }

    log("error", "ai-answer failed", { userId, projectId, mode, error: getErrorMessage(error) })
    return NextResponse.json({ error: "Gagal mengambil jawaban. Coba lagi." }, { status: 500 })
  }
}
