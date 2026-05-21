import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { splitWorkspaceStateFiles } from "@/lib/workspace-state"
import { chooseModelForTask } from "@/lib/ai/model-router"
import { buildContextForTask } from "@/lib/ai/context-builder"
import { ProviderRouter } from "@/lib/ai/provider-router"
import type { ProviderName } from "@/lib/ai/provider-router"
import { parseGeneratedArtifact, type GeneratedArtifact } from "@/lib/ai/generated-artifact"
import { enforceUserRateLimit } from "@/lib/security/rate-limit"
import { log } from "@/lib/logging"
import * as Executor from "@/lib/orchestrator/executor"
import { MAX_AUTOMATIC_REPAIR_ATTEMPTS, routeModelForRequest } from "@/lib/ai/generation-pipeline"
import {
  captureRuntimeError,
  createRuntimeSnapshot,
  diagnoseRuntimeError,
  filterRepairOutputToScope,
  isolateRepairScope,
  recordRuntimeRecoveryEvent,
  rollbackToSnapshot,
  shouldStopRepeatedRepairLoop,
} from "@/lib/observability/runtime-recovery"

export const runtime = "nodejs"

type RepairAttempt = {
  attempt: number
  ok: boolean
  error?: string
  reason?: string
  parseMode?: string
  applied?: string[]
  rejected?: string[]
  model?: string
  layer?: string
  outputHash?: string
}

const MAX_MESSAGE_LENGTH = 4000
const MAX_STACK_LENGTH = 12000
const MAX_FILE_LENGTH = 260

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function cleanString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : ""
}

function hashFiles(files: Array<{ path: string; content: string }>) {
  return createHash("sha256")
    .update(JSON.stringify(files.map((file) => ({ path: file.path, content: file.content }))))
    .digest("hex")
}

function inferGeneratedLanguage(path: string) {
  if (/\.tsx$/i.test(path)) return "tsx" as const
  if (/\.css$/i.test(path)) return "css" as const
  if (/\.json$/i.test(path)) return "json" as const
  if (/\.html$/i.test(path)) return "html" as const
  if (/\.prisma$/i.test(path)) return "prisma" as const
  if (/\.md$/i.test(path)) return "md" as const
  if (/\.env(?:\.example)?$/i.test(path)) return "env" as const
  return "ts" as const
}

async function resolveSessionUserId() {
  const session = await auth()
  const userId = session?.user?.id

  if (userId) {
    return { session, userId }
  }

  const email = session?.user?.email?.trim().toLowerCase()
  if (!email) {
    return { session, userId: null }
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  })

  return { session, userId: user?.id ?? null }
}

async function requireProjectMember(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspace: {
        select: {
          members: {
            where: { userId },
            select: { role: true },
            take: 1,
          },
        },
      },
    },
  })

  if (!project) {
    return { ok: false as const, status: 404, error: "Project not found" }
  }

  if (project.workspace.members.length === 0) {
    return { ok: false as const, status: 403, error: "Forbidden" }
  }

  return { ok: true as const, projectId: project.id, role: project.workspace.members[0]?.role ?? "member" }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const { session, userId } = await resolveSessionUserId()

  if (!session?.user || !userId) {
    log("warn", "preview-error denied", { reason: "unauthorized" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    await enforceUserRateLimit(`preview-error:${userId}`)
  } catch (error) {
    log("warn", "preview-error rate limited", { userId })
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 429 })
  }

  try {
    const payload = await req.json()
    const message = cleanString(payload.message, MAX_MESSAGE_LENGTH)
    const stack = cleanString(payload.stack, MAX_STACK_LENGTH)
    const file = cleanString(payload.file, MAX_FILE_LENGTH) || null
    const lineno = payload.lineno ?? null
    const colno = payload.colno ?? null
    const projectId = cleanString(payload.projectId, 160) || null

    if (!projectId) {
      log("info", "preview-error ignored", { userId, reason: "missing_project_id" })
      return NextResponse.json({ success: true, note: "no projectId provided" })
    }

    const access = await requireProjectMember(projectId, userId)
    if (!access.ok) {
      log("warn", "preview-error denied", {
        userId,
        projectId,
        reason: access.error,
        status: access.status,
      })
      return NextResponse.json({ error: access.error }, { status: access.status })
    }

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
    } catch {
      // ignore logging errors
    }

    // Load a small set of relevant files for context
    const projectFiles = await prisma.projectFile.findMany({ where: { projectId }, select: { path: true, content: true } })
    const { files: visibleProjectFiles } = splitWorkspaceStateFiles(
      projectFiles.map((projectFile) => ({
        path: projectFile.path,
        content: projectFile.content,
        language: projectFile.path.endsWith(".tsx") ? ("tsx" as const) : ("ts" as const),
      }))
    )

    // Build inspect prompt
    const contextFiles = visibleProjectFiles.slice(0, 8).map((projectFile) => ({
      ...projectFile,
      language: inferGeneratedLanguage(projectFile.path),
    }))
    const allProjectFiles = visibleProjectFiles.map((projectFile) => ({
      ...projectFile,
      language: inferGeneratedLanguage(projectFile.path),
    }))
    const capture = await captureRuntimeError({
      projectId,
      message: message || "Preview runtime error",
      stack,
      file,
      lineno: typeof lineno === "number" ? lineno : null,
      colno: typeof colno === "number" ? colno : null,
      source: "preview",
      severity: "error",
      metadata: {
        userId,
        role: access.role,
      },
    })
    const diagnosis = diagnoseRuntimeError({
      error: `${message}\n${stack}`,
      files: allProjectFiles,
      fallbackTargets: file ? [file] : [],
    })
    const isolatedScope = isolateRepairScope({
      files: allProjectFiles,
      diagnosis,
    })
    await recordRuntimeRecoveryEvent({
      capture,
      phase: "diagnose",
      diagnosis,
      message: "Runtime error diagnosed and routed",
      metadata: {
        route: diagnosis.route,
        targetPaths: isolatedScope.targetPaths,
        preservePathCount: isolatedScope.preservePaths.length,
      },
    })

    if (diagnosis.route !== "targeted_repair" || isolatedScope.targetPaths.length === 0) {
      await recordRuntimeRecoveryEvent({
        capture,
        phase: "isolate",
        diagnosis,
        status: "failed",
        message: "Runtime error could not be safely isolated for automatic repair",
        metadata: {
          targetPaths: isolatedScope.targetPaths,
          fullRegenerationAllowed: false,
        },
      })
      return NextResponse.json({
        success: false,
        correlationId: capture.correlationId,
        error: "Runtime error captured, but automatic repair was blocked because the failed scope could not be isolated.",
        diagnosis,
        attempts: [],
      }, { status: 422 })
    }

    const activeFile = contextFiles.find((f) => f.path === file) || null
    const inspectContext = buildContextForTask({ prompt: message + "\n\nStack:\n" + stack, files: contextFiles, activeFile })
    const snapshot = await createRuntimeSnapshot({
      projectId,
      prompt: `runtime-snapshot:${capture.correlationId}`,
      files: allProjectFiles,
      idempotencyKey: `runtime-snapshot:${capture.correlationId}`,
      intent: "runtime-repair",
    })
    await recordRuntimeRecoveryEvent({
      capture,
      phase: "isolate",
      diagnosis,
      message: "Last known project state snapshotted before targeted repair",
      metadata: {
        historyId: snapshot.historyId,
        targetPaths: isolatedScope.targetPaths,
        fileHash: snapshot.fileHash,
      },
    })

    // Agent loop: two automatic attempts max. Premium repair is returned as
    // an escalation option so expensive models are never used by default.
    const attempts: RepairAttempt[] = []
    for (let attempt = 0; attempt < MAX_AUTOMATIC_REPAIR_ATTEMPTS; attempt += 1) {
      const loopStop = shouldStopRepeatedRepairLoop({
        attempts,
        maxAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
      })
      if (loopStop.stop) {
        await recordRuntimeRecoveryEvent({
          capture,
          phase: "targeted_repair",
          diagnosis,
          status: "failed",
          message: "Repeated repair loop stopped before another provider call",
          metadata: {
            reason: loopStop.reason,
            attempts: attempts.length,
          },
        })
        break
      }
      const routeDecision = routeModelForRequest({
        prompt: `${message}\n${stack}`,
        purpose: "repair",
        existingFiles: contextFiles,
        previewError: message,
        repairAttempt: attempt,
      })
      const modelChoice = chooseModelForTask("repair", {
        prompt: `${message}\n${stack}`,
        existingFiles: contextFiles,
        previewError: message,
        repairAttempt: attempt,
      })

      const systemPrompt = `You are a senior fullstack debugger for a Next.js preview.\nUse canonical workspace-relative POSIX paths only, for example app/page.tsx. Never use leading slashes, ./ prefixes, traversal, or Windows separators.\nTARGETED_REPAIR_ONLY: change only these paths: ${isolatedScope.targetPaths.join(", ")}.\nNever regenerate the app, never rewrite unrelated files, and preserve every successful file outside that target list.\nRespond ONLY with a valid JSON object: {"files":[{"path":"app/page.tsx","language":"tsx","content":"<full file content>"}],"dependencies":[],"diagnostics":[],"metadata":{},"repairs":[]}. No explanation, no markdown, no extra text.`

      const fullPrompt = `${systemPrompt}\n\nError correlation ID: ${capture.correlationId}\n\nDiagnosis:\n${JSON.stringify(diagnosis, null, 2)}\n\nError:\n${message}\n\nStack:\n${stack}\n\nContext:\n${inspectContext}`

      let providerResp
      try {
        providerResp = await ProviderRouter.generate({
          provider: modelChoice.provider as ProviderName,
          modelName: modelChoice.modelName,
          prompt: fullPrompt,
          mode: "inspect",
        })
      } catch (err: unknown) {
        attempts.push({
          attempt,
          ok: false,
          error: getErrorMessage(err),
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        continue
      }

      let parsed: GeneratedArtifact
      try {
        parsed = parseGeneratedArtifact(providerResp.message)
      } catch (err: unknown) {
        attempts.push({
          attempt,
          ok: false,
          reason: "malformed_generated_artifact",
          error: getErrorMessage(err),
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        continue
      }

      const scopedRepair = filterRepairOutputToScope({
        files: parsed.files,
        targetPaths: isolatedScope.targetPaths,
      })
      const outputHash = hashFiles(scopedRepair.accepted)
      const repeatedStop = shouldStopRepeatedRepairLoop({
        attempts,
        nextOutputHash: outputHash,
        maxAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
      })
      if (repeatedStop.stop) {
        attempts.push({
          attempt,
          ok: false,
          reason: repeatedStop.reason || "repair_loop_stopped",
          rejected: scopedRepair.rejected,
          outputHash,
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        await recordRuntimeRecoveryEvent({
          capture,
          phase: "targeted_repair",
          diagnosis,
          status: "failed",
          message: "Repeated repair loop stopped after identical repair output",
          metadata: {
            reason: repeatedStop.reason,
            rejectedFiles: scopedRepair.rejected,
          },
        })
        break
      }

      if (scopedRepair.accepted.length === 0) {
        attempts.push({
          attempt,
          ok: false,
          reason: "empty_targeted_repair_output",
          rejected: scopedRepair.rejected,
          outputHash,
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        continue
      }

      try {
        const saved = await Executor.applyFiles(projectId, `preview-repair:${capture.correlationId}:${attempt}`, scopedRepair.accepted)
        const validation = await Executor.validateFiles(saved.files)
        if (!validation.valid) {
          await rollbackToSnapshot({
            projectId,
            historyId: snapshot.historyId,
            reason: `validation_failed_after_runtime_repair:${capture.correlationId}`,
          })
          attempts.push({
            attempt,
            ok: false,
            reason: "validation_failed_after_targeted_repair",
            error: JSON.stringify(validation.result.missingCategories || validation.result).slice(0, 1000),
            applied: scopedRepair.accepted.map((f) => f.path),
            rejected: scopedRepair.rejected,
            outputHash,
            model: routeDecision.modelName,
            layer: routeDecision.layer,
          })
          await recordRuntimeRecoveryEvent({
            capture,
            phase: "rollback",
            diagnosis,
            status: "failed",
            message: "Targeted repair failed validation and was rolled back",
            metadata: {
              snapshotHistoryId: snapshot.historyId,
              validation: validation.result,
            },
          })
          continue
        }
        attempts.push({
          attempt,
          ok: true,
          applied: scopedRepair.accepted.map((f) => f.path),
          rejected: scopedRepair.rejected,
          outputHash,
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        await recordRuntimeRecoveryEvent({
          capture,
          phase: "validation",
          diagnosis,
          message: "Targeted repair passed validation",
          metadata: {
            historyId: saved.historyId,
            appliedFiles: scopedRepair.accepted.map((f) => f.path),
            rejectedFiles: scopedRepair.rejected,
          },
        })
        break
      } catch (err: unknown) {
        await rollbackToSnapshot({
          projectId,
          historyId: snapshot.historyId,
          reason: `targeted_repair_apply_failed:${capture.correlationId}`,
        }).catch(() => null)
        attempts.push({
          attempt,
          ok: false,
          error: getErrorMessage(err),
          rejected: scopedRepair.rejected,
          outputHash,
          model: routeDecision.modelName,
          layer: routeDecision.layer,
        })
        continue
      }
    }
    const premiumEscalation = attempts.some((attempt) => attempt.ok)
      ? null
      : routeModelForRequest({
          prompt: `${message}\n${stack}`,
          purpose: "repair",
          existingFiles: contextFiles,
          previewError: message,
          repairAttempt: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
          allowPremiumEscalation: true,
        })

    log("info", "preview-error repair completed", {
      correlationId: capture.correlationId,
      userId,
      projectId,
      role: access.role,
      diagnosis,
      attempts: attempts.length,
      maxAutomaticRepairAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
      premiumEscalationSuggested: Boolean(premiumEscalation),
      appliedFiles: attempts.flatMap((attempt) => attempt.applied ?? []).length,
      latencyMs: Date.now() - startedAt,
    })

    return NextResponse.json({
      success: true,
      correlationId: capture.correlationId,
      diagnosis,
      snapshot: {
        historyId: snapshot.historyId,
      },
      attempts,
      maxAutomaticRepairAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
      premiumEscalation: premiumEscalation
        ? {
            model: premiumEscalation.modelName,
            layer: premiumEscalation.layer,
            reason: premiumEscalation.reason,
          }
        : null,
    })
  } catch (err: unknown) {
    log("error", "preview-error failed", { userId, error: getErrorMessage(err) })
    return NextResponse.json({ success: false, error: getErrorMessage(err) }, { status: 500 })
  }
}

export const GET = async () => {
  const { userId } = await resolveSessionUserId()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return NextResponse.json({ ok: true })
}
