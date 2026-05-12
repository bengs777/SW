import { performance } from "node:perf_hooks"
import type { GeneratedFile } from "@/lib/types"
import { buildContextForTask } from "@/lib/ai/context-builder"
import {
  buildDependencyMap,
  buildStaticValidationPrompt,
  classifyPrompt,
  normalizeGeneratedDependencies,
  routeModelForRequest,
  trimContextForGeneration,
  type DependencyMap,
} from "@/lib/ai/generation-pipeline"
import { validateFullStackFiles } from "@/lib/ai/fullstack-validator"
import { extractGeneratedFilesFromProviderMessage, mergeGeneratedFiles } from "@/lib/ai/provider-output"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { compileProject } from "@/lib/preview/module-resolution"
import { startRuntimeSandbox } from "@/lib/sandbox/runtime"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { GenerationJobCancelledError, GenerationJobService, type GenerationJobStage } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

type GenerationPlannerFile = {
  path: string
  reason: string
  action: "create_or_update"
}

type GenerationPlan = {
  objective: string
  filePlan: GenerationPlannerFile[]
  contextBudget: {
    maxFiles: number
    maxCharsPerFile: number
    maxTotalChars: number
    usedFiles: number
    usedChars: number
  }
}

type ExecuteGenerationJobInput = {
  jobId: string
  projectId: string
  prompt: string
  selectedModel: string
  promptLanguage?: "id" | "en"
  collaborationMode?: string
  signal?: AbortSignal
}

type ExecuteGenerationJobDeps = {
  loadProjectFiles: (projectId: string) => Promise<GeneratedFile[]>
}

const MAX_REPAIR_ATTEMPTS = 2

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    }
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
  }
}

function buildGenerationPlan(prompt: string, existingFiles: GeneratedFile[]) {
  const classification = classifyPrompt(prompt, { existingFiles })
  const trimmed = trimContextForGeneration({
    prompt,
    files: existingFiles,
    layer: classification === "simple_ui" ? "fast" : "builder",
  })

  const filePlan: GenerationPlannerFile[] = trimmed.files.slice(0, 8).map((file) => ({
    path: file.path,
    reason: "Relevant existing file selected by context ranking",
    action: "create_or_update",
  }))

  if (!filePlan.some((item) => /^app\/page\.(tsx|ts|jsx|js)$/i.test(item.path))) {
    filePlan.unshift({
      path: "app/page.tsx",
      reason: "Primary visible entrypoint should be generated or refined first",
      action: "create_or_update",
    })
  }

  return {
    objective: classification,
    filePlan,
    contextBudget: {
      ...trimmed.budget,
      usedFiles: trimmed.files.length,
      usedChars: trimmed.totalChars,
    },
  } satisfies GenerationPlan
}

async function transition(jobId: string, stage: GenerationJobStage, label: string, progress: number, data?: Record<string, unknown>) {
  await GenerationJobService.transition(jobId, {
    type: `job.stage.${stage}`,
    status: stage === "completed" ? "completed" : stage === "failed" ? "failed" : stage === "cancelled" ? "cancelled" : "running",
    stage,
    label,
    progress,
    message: label,
    data,
  })
}

async function runProviderAttempt(input: {
  jobId: string
  prompt: string
  purpose: "generate" | "repair"
  selectedModel: string
  promptLanguage: "id" | "en"
  signal?: AbortSignal
}) {
  const route = routeModelForRequest({
    prompt: input.prompt,
    purpose: input.purpose,
  })
  const startedAt = performance.now()
  const attempt = await GenerationJobService.startAttempt({
    jobId: input.jobId,
    provider: route.provider,
    model: route.modelName,
    purpose: input.purpose,
    metadata: {
      layer: route.layer,
      classification: route.classification,
      complexity: route.complexity,
      reason: route.reason,
    },
  })

  try {
    const response = await ProviderRouter.generate({
      provider: route.provider,
      modelName: route.modelName,
      prompt: input.prompt,
      mode: "files",
      promptLanguage: input.promptLanguage,
      signal: input.signal,
    })

    await GenerationJobService.finishAttempt({
      jobId: input.jobId,
      sequence: attempt.sequence,
      status: "completed",
      latencyMs: performance.now() - startedAt,
      promptTokens: response.tokenUsage?.promptTokens,
      completionTokens: response.tokenUsage?.completionTokens,
      totalTokens: response.tokenUsage?.totalTokens,
      metadata: {
        providerAttempts: response.attempts,
      },
    })

    return response
  } catch (error) {
    await GenerationJobService.finishAttempt({
      jobId: input.jobId,
      sequence: attempt.sequence,
      status: error instanceof GenerationJobCancelledError ? "cancelled" : "failed",
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function buildSlicePrompt(input: {
  prompt: string
  plan: GenerationPlan
  existingFiles: GeneratedFile[]
  target: GenerationPlannerFile
}) {
  const context = buildContextForTask({
    prompt: input.prompt,
    files: input.existingFiles,
    maxFiles: 10,
    layer: "builder",
  })

  return [
    context,
    "",
    "EXECUTION_RULES:",
    "- Work only on the requested file slice and directly related imports.",
    "- Return only changed files.",
    "- Prefer patch-safe, deterministic updates.",
    `- Current file objective: ${input.target.path}`,
    `- Why this file matters: ${input.target.reason}`,
    `- Planned objective: ${input.plan.objective}`,
  ].join("\n")
}

function pickFailingFiles(files: GeneratedFile[], dependencyMap: DependencyMap, compileError: string) {
  const failing = new Set<string>()

  for (const item of dependencyMap.missingLocalImports.slice(0, 6)) {
    failing.add(item.file)
    if (item.candidates[0]) {
      failing.add(item.candidates[0])
    }
  }

  const match = compileError.match(/in\s+([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))/i)
  if (match?.[1]) {
    failing.add(match[1].replace(/\\/g, "/"))
  }

  return files.filter((file) => failing.has(file.path)).slice(0, 6)
}

async function attemptTargetedRepair(input: {
  jobId: string
  prompt: string
  files: GeneratedFile[]
  compileError: string
  promptLanguage: "id" | "en"
  signal?: AbortSignal
}) {
  let currentFiles = [...input.files]
  let lastError = input.compileError

  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    await GenerationJobService.assertNotCancelled(input.jobId)
    const dependencyMap = buildDependencyMap(currentFiles)
    const failingFiles = pickFailingFiles(currentFiles, dependencyMap, lastError)
    const repairPrompt = [
      buildStaticValidationPrompt({
        prompt: input.prompt,
        dependencyMap,
        packageJson: currentFiles.find((file) => file.path === "package.json") || null,
        previewError: lastError,
      }),
      "",
      "TARGETED_REPAIR_ONLY:",
      "- Repair only the failing files or their direct imports.",
      "- Do not regenerate the entire project.",
      `- Repair attempt: ${attempt + 1} / ${MAX_REPAIR_ATTEMPTS}`,
      "",
      "FAILING_FILES_CONTEXT:",
      failingFiles.map((file) => `FILE ${file.path}\n${file.content}`).join("\n\n"),
    ].join("\n")

    const response = await runProviderAttempt({
      jobId: input.jobId,
      prompt: repairPrompt,
      purpose: "repair",
      selectedModel: "repair",
      promptLanguage: input.promptLanguage,
      signal: input.signal,
    })
    const parsed = extractGeneratedFilesFromProviderMessage(response.message)
    if (parsed.files.length === 0) {
      break
    }

    currentFiles = mergeGeneratedFiles(currentFiles, parsed.files)

    try {
      compileProject(currentFiles)
      return {
        files: currentFiles,
        repaired: true,
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    files: currentFiles,
    repaired: false,
    error: lastError,
  }
}

export async function executeGenerationJob(
  input: ExecuteGenerationJobInput,
  deps: ExecuteGenerationJobDeps
) {
  const promptLanguage = input.promptLanguage || "id"
  const metrics: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
  }

  try {
    await GenerationJobService.markRunning(input.jobId, "Preparing generation plan")
    await GenerationJobService.assertNotCancelled(input.jobId)

    const existingFiles = await deps.loadProjectFiles(input.projectId)
    const plan = buildGenerationPlan(input.prompt, existingFiles)
    await GenerationJobService.transition(input.jobId, {
      type: "job.plan.ready",
      status: "running",
      stage: "generating",
      label: "Generation plan ready",
      progress: 10,
      plan,
      context: {
        fileCount: existingFiles.length,
      },
      message: "Generation plan ready",
      data: {
        objective: plan.objective,
        filePlan: plan.filePlan,
      },
    })

    let workingFiles = [...existingFiles]

    for (let index = 0; index < plan.filePlan.length; index += 1) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      const target = plan.filePlan[index]
      const response = await runProviderAttempt({
        jobId: input.jobId,
        prompt: buildSlicePrompt({
          prompt: input.prompt,
          plan,
          existingFiles: workingFiles,
          target,
        }),
        purpose: "generate",
        selectedModel: input.selectedModel,
        promptLanguage,
        signal: input.signal,
      })

      const parsed = extractGeneratedFilesFromProviderMessage(response.message)
      if (parsed.files.length === 0) {
        continue
      }

      workingFiles = mergeGeneratedFiles(workingFiles, parsed.files)
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files

      await transition(
        input.jobId,
        "parsing",
        `Parsed generation slice ${index + 1}/${plan.filePlan.length}`,
        Math.min(55, 15 + Math.round(((index + 1) / Math.max(1, plan.filePlan.length)) * 35)),
        {
          target: target.path,
          parseFileCount: parsed.files.length,
          addedPackages: normalized.addedPackages,
        }
      )
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    await transition(input.jobId, "validating", "Validating generated artifacts", 60)

    const fullstack = validateFullStackFiles(workingFiles)
    const dependencyMap = buildDependencyMap(workingFiles)
    if (fullstack.missingCategories.length > 0 || dependencyMap.missingLocalImports.length > 0) {
      await transition(input.jobId, "repairing", "Repairing failing files only", 70, {
        missingCategories: fullstack.missingCategories,
        missingLocalImports: dependencyMap.missingLocalImports.slice(0, 10),
      })
    }

    await transition(input.jobId, "compiling", "Compiling preview artifacts", 78)

    let compileError = ""
    try {
      compileProject(workingFiles)
    } catch (error) {
      compileError = error instanceof Error ? error.message : String(error)
    }

    if (compileError) {
      const repaired = await attemptTargetedRepair({
        jobId: input.jobId,
        prompt: input.prompt,
        files: workingFiles,
        compileError,
        promptLanguage,
        signal: input.signal,
      })
      workingFiles = repaired.files
      if (!repaired.repaired) {
        throw new Error(repaired.error || compileError)
      }
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    await transition(input.jobId, "saving", "Saving project artifacts", 88)

    const saveResult = await ProjectFilePersistenceService.saveBufferedArtifacts({
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
    })

    await GenerationJobService.assertNotCancelled(input.jobId)
    await transition(input.jobId, "compiling", "Starting isolated preview sandbox", 94)

    const preview = await startRuntimeSandbox(input.projectId, workingFiles)
    metrics.previewStatus = preview.status
    metrics.previewError = preview.error || null

    if (preview.error) {
      log("warn", "Preview sandbox compile failed", {
        jobId: input.jobId,
        projectId: input.projectId,
        error: preview.error,
      })
    }

    await GenerationJobService.update(input.jobId, {
      metrics,
      previewUrl: preview.previewUrl,
    })
    await GenerationJobService.markCompleted(input.jobId, saveResult.historyId, preview.previewUrl)

    return {
      historyId: saveResult.historyId,
      files: workingFiles,
      previewUrl: preview.previewUrl,
    }
  } catch (error) {
    if (error instanceof GenerationJobCancelledError) {
      await GenerationJobService.markCancelled(input.jobId, "Generation cancelled")
      throw error
    }

    const serialized = serializeError(error)
    await GenerationJobService.update(input.jobId, {
      diagnostics: serialized,
      metrics,
    })
    await GenerationJobService.markFailed(input.jobId, serialized.message)
    throw error
  }
}
