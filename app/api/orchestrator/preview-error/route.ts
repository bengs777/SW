import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/client"
import { chooseModelForTask } from "@/lib/ai/model-router"
import { buildContextForTask } from "@/lib/ai/context-builder"
import { ProviderRouter } from "@/lib/ai/provider-router"
import type { ProviderName } from "@/lib/ai/provider-router"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import * as Executor from "@/lib/orchestrator/executor"

export const runtime = "nodejs"

async function safeJsonParse(body: any) {
  try {
    return JSON.parse(String(body))
  } catch {
    return body
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json()
    const message = payload.message || ""
    const stack = payload.stack || ""
    const file = payload.file || null
    const lineno = payload.lineno ?? null
    const colno = payload.colno ?? null
    const projectId = payload.projectId || null

    // Persist a request log entry
    try {
      await prisma.requestLog.create({
        data: {
          projectId: projectId || "",
          taskType: "preview-error",
          modelUsed: "runtime-preview",
          provider: null,
          latencyMs: 0,
          tokens: 0,
          success: false,
          errorMessage: message ? String(message).slice(0, 2000) : undefined,
          contextJson: JSON.stringify({ message, stack, file, lineno, colno }),
        },
      })
    } catch (e) {
      // ignore logging errors
    }

    if (!projectId) {
      return NextResponse.json({ success: true, note: "no projectId provided" })
    }

    // Load a small set of relevant files for context
    const projectFiles = await prisma.projectFile.findMany({ where: { projectId }, select: { path: true, content: true } })

    // Build inspect prompt
    const contextFiles = projectFiles.slice(0, 8).map((projectFile) => ({
      ...projectFile,
      language: projectFile.path.endsWith(".tsx") ? "tsx" as const : "ts" as const,
    }))
    const activeFile = contextFiles.find((f) => f.path === file) || null
    const inspectContext = buildContextForTask({ prompt: message + "\n\nStack:\n" + stack, files: contextFiles, activeFile })

    // Agent loop: try up to 3 inspect attempts
    const attempts = [] as any[]
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const modelChoice = chooseModelForTask("inspect")

      const systemPrompt = `You are a senior fullstack debugger for a Next.js preview.\nRespond ONLY with a valid JSON array of files to PATCH. Each entry must be an object: {"path":"app/page.tsx","content":"<full file content>"}. No explanation, no markdown, no extra text.`

      const fullPrompt = `${systemPrompt}\n\nError:\n${message}\n\nStack:\n${stack}\n\nContext:\n${inspectContext}`

      let providerResp
      try {
        providerResp = await ProviderRouter.generate({
          provider: modelChoice.provider as ProviderName,
          modelName: modelChoice.modelName,
          prompt: fullPrompt,
          mode: "inspect",
        })
      } catch (err: any) {
        attempts.push({ attempt, ok: false, error: String(err?.message || err) })
        break
      }

      const parsed = extractGeneratedFilesFromProviderMessage(providerResp.message)
      if (!parsed.files || parsed.files.length === 0) {
        attempts.push({ attempt, ok: false, reason: 'no_files_parsed', parseMode: parsed.parseMode })
        break
      }

      try {
        await Executor.applyFiles(projectId, `preview-inspect:${attempt}`, parsed.files)
        attempts.push({ attempt, ok: true, applied: parsed.files.map((f) => f.path) })
      } catch (err: any) {
        attempts.push({ attempt, ok: false, error: String(err?.message || err) })
        break
      }

      // If we applied patches, let the client reload preview and re-report if error persists.
      // Continue loop to allow up to 3 sequential repair attempts without client involvement.
    }

    return NextResponse.json({ success: true, attempts })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export const GET = () => {
  return NextResponse.json({ ok: true })
}
