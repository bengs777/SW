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
import { parseGeneratedArtifact } from "@/lib/ai/generated-artifact"
import { mergeGeneratedFiles } from "@/lib/ai/provider-output"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { compileProject } from "@/lib/preview/module-resolution"
import { startRuntimeSandbox, type SandboxValidationStep } from "@/lib/sandbox/runtime"
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

type ValidationLifecycleStep =
  | "normalize"
  | "static"
  | "preview-compile"
  | "typecheck"
  | "lint"
  | "build"

type ValidationLifecycleStepResult = {
  name: ValidationLifecycleStep
  status: "passed" | "failed" | "skipped"
  policy: "required" | "advisory"
  durationMs: number
  message?: string
  data?: Record<string, unknown>
}

type ValidationLifecycleFailure = {
  step: ValidationLifecycleStep
  message: string
  data?: Record<string, unknown>
}

type ValidationLifecycleResult = {
  ok: boolean
  files: GeneratedFile[]
  previewUrl: string | null
  previewStatus: string | null
  steps: ValidationLifecycleStepResult[]
  sandboxValidation: SandboxValidationStep[]
  failure?: ValidationLifecycleFailure
}

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

  for (const filePath of extractFilePathsFromError(compileError)) {
    failing.add(filePath)
  }

  const matchedFiles = files.filter((file) => failing.has(normalizePath(file.path))).slice(0, 8)
  if (matchedFiles.length > 0) {
    return matchedFiles
  }

  return files
    .filter((file) =>
      /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(normalizePath(file.path)) ||
      /^components\//i.test(normalizePath(file.path)) ||
      normalizePath(file.path) === "package.json"
    )
    .slice(0, 8)
}

function extractFilePathsFromError(message: string) {
  const paths = new Set<string>()
  const patterns = [
    /in\s+([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))/gi,
    /(?:^|\s|\.\/)([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|json|css|prisma))(?::\d+:\d+)?/gim,
  ]

  for (const pattern of patterns) {
    for (const match of String(message || "").matchAll(pattern)) {
      if (match[1]) {
        paths.add(normalizePath(match[1]))
      }
    }
  }

  return Array.from(paths)
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function shouldRequireFullStackCoverage(plan: GenerationPlan) {
  return ["fullstack_app", "architecture", "refactor", "runtime_debug"].includes(plan.objective)
}

function summarizeSandboxStep(step: SandboxValidationStep): ValidationLifecycleStepResult | null {
  if (step.name !== "typecheck" && step.name !== "lint" && step.name !== "build") {
    return null
  }

  return {
    name: step.name,
    status: step.status,
    policy: step.policy,
    durationMs: step.durationMs || 0,
    message: step.reason,
    data: {
      command: step.command || null,
      output: step.output || null,
    },
  }
}

function failureStepFromSandbox(validation: SandboxValidationStep[]): ValidationLifecycleStep {
  const failed = validation.find((step) => step.status === "failed" && step.policy === "required")
  if (failed?.name === "typecheck" || failed?.name === "lint" || failed?.name === "build") {
    return failed.name
  }

  return "build"
}

async function runValidationLifecycle(input: {
  jobId: string
  projectId: string
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  signal?: AbortSignal
  emit: (stage: GenerationJobStage, label: string, progress: number, data?: Record<string, unknown>) => Promise<void>
}): Promise<ValidationLifecycleResult> {
  let files = [...input.files]
  const steps: ValidationLifecycleStepResult[] = []
  const recordStep = (
    name: ValidationLifecycleStep,
    status: ValidationLifecycleStepResult["status"],
    policy: ValidationLifecycleStepResult["policy"],
    stepStartedAt: number,
    message?: string,
    data?: Record<string, unknown>
  ) => {
    steps.push({
      name,
      status,
      policy,
      durationMs: Math.max(0, Math.round(performance.now() - stepStartedAt)),
      message,
      data,
    })
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  let stepStartedAt = performance.now()
  await input.emit("validating", "Normalizing generated artifacts", 60)
  const normalized = normalizeGeneratedDependencies(files)
  files = normalized.files
  recordStep("normalize", "passed", "required", stepStartedAt, undefined, {
    fileCount: files.length,
    addedPackages: normalized.addedPackages,
    normalizedPackages: normalized.normalizedPackages,
    conflictsPrevented: normalized.conflictsPrevented,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Checking static project invariants", 66)
  const fullstack = validateFullStackFiles(files)
  const dependencyMap = buildDependencyMap(files)
  const staticFailures: string[] = []
  const requiresFullStackCoverage = shouldRequireFullStackCoverage(input.plan)

  if (dependencyMap.missingLocalImports.length > 0) {
    staticFailures.push(`Missing local imports: ${dependencyMap.missingLocalImports.length}`)
  }

  if (dependencyMap.unsupportedPreviewImports.length > 0) {
    staticFailures.push(`Unsupported preview imports: ${dependencyMap.unsupportedPreviewImports.length}`)
  }

  if (requiresFullStackCoverage && fullstack.missingCategories.length > 0) {
    staticFailures.push(`Missing required full-stack categories: ${fullstack.missingCategories.join(", ")}`)
  }

  if (staticFailures.length > 0) {
    const message = staticFailures.join("; ")
    const data = {
      coverage: fullstack.coverage,
      missingCategories: fullstack.missingCategories,
      fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
      missingLocalImports: dependencyMap.missingLocalImports.slice(0, 12),
      unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
    }
    recordStep("static", "failed", "required", stepStartedAt, message, data)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "static",
        message,
        data,
      },
    }
  }

  recordStep("static", "passed", "required", stepStartedAt, undefined, {
    coverage: fullstack.coverage,
    missingCategories: fullstack.missingCategories,
    fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
    localImportCount: dependencyMap.localImports.length,
    externalPackages: dependencyMap.externalPackages,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Compiling preview module graph", 74)
  try {
    compileProject(files)
    recordStep("preview-compile", "passed", "required", stepStartedAt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordStep("preview-compile", "failed", "required", stepStartedAt, message)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "preview-compile",
        message,
      },
    }
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("building", "Running typecheck, lint, and production build", 84)
  const preview = await startRuntimeSandbox(input.projectId, files, { signal: input.signal })
  for (const sandboxStep of preview.validation) {
    const lifecycleStep = summarizeSandboxStep(sandboxStep)
    if (lifecycleStep) {
      steps.push(lifecycleStep)
    }
  }

  if (preview.error) {
    const step = failureStepFromSandbox(preview.validation)
    recordStep(step, "failed", "required", stepStartedAt, preview.error, {
      sandboxStatus: preview.status,
      sandboxValidation: preview.validation,
      logs: preview.logs.slice(-80),
    })
    return {
      ok: false,
      files,
      previewUrl: preview.previewUrl,
      previewStatus: preview.status,
      steps,
      sandboxValidation: preview.validation,
      failure: {
        step,
        message: preview.error,
        data: {
          sandboxStatus: preview.status,
          sandboxValidation: preview.validation,
          logs: preview.logs.slice(-80),
        },
      },
    }
  }

  if (!preview.validation.some((step) => step.name === "build" && step.status === "passed")) {
    const message = "Production build did not report a passing build gate."
    recordStep("build", "failed", "required", stepStartedAt, message, {
      sandboxStatus: preview.status,
      sandboxValidation: preview.validation,
    })
    return {
      ok: false,
      files,
      previewUrl: preview.previewUrl,
      previewStatus: preview.status,
      steps,
      sandboxValidation: preview.validation,
      failure: {
        step: "build",
        message,
      },
    }
  }

  return {
    ok: true,
    files,
    previewUrl: preview.previewUrl,
    previewStatus: preview.status,
    steps,
    sandboxValidation: preview.validation,
  }
}

async function attemptTargetedRepair(input: {
  jobId: string
  prompt: string
  files: GeneratedFile[]
  validationError: string
  repairAttempt: number
  maxRepairAttempts: number
  promptLanguage: "id" | "en"
  signal?: AbortSignal
}) {
  await GenerationJobService.assertNotCancelled(input.jobId)
  const currentFiles = [...input.files]
  const dependencyMap = buildDependencyMap(currentFiles)
  const failingFiles = pickFailingFiles(currentFiles, dependencyMap, input.validationError)
  const repairPrompt = [
    buildStaticValidationPrompt({
      prompt: input.prompt,
      dependencyMap,
      packageJson: currentFiles.find((file) => normalizePath(file.path) === "package.json") || null,
      previewError: input.validationError,
    }),
    "",
    "DETERMINISTIC_VALIDATION_FAILURE:",
    input.validationError,
    "",
    "TARGETED_REPAIR_ONLY:",
    "- Repair only the failing files or their direct imports.",
    "- Do not regenerate the entire project.",
    "- Return only changed files.",
    "- The result will be revalidated through normalize -> static validation -> preview compile -> typecheck -> lint -> build before persistence.",
    `- Repair attempt: ${input.repairAttempt} / ${input.maxRepairAttempts}`,
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
  const parsed = parseGeneratedArtifact(response.message)
  const mergedFiles = mergeGeneratedFiles(currentFiles, parsed.files)
  const normalized = normalizeGeneratedDependencies(mergedFiles)

  return {
    files: normalized.files,
    repaired: parsed.files.length > 0,
    parsedFileCount: parsed.files.length,
    normalizedPackages: normalized.normalizedPackages,
    addedPackages: normalized.addedPackages,
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

      const parsed = parseGeneratedArtifact(response.message)

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
    let validation = await runValidationLifecycle({
      jobId: input.jobId,
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      plan,
      signal: input.signal,
      emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
    })

    let repairAttempt = 0
    while (!validation.ok && repairAttempt < MAX_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      await GenerationJobService.assertNotCancelled(input.jobId)
      await transition(
        input.jobId,
        "repairing",
        `Repairing validation failure ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}`,
        Math.min(88, 72 + repairAttempt * 5),
        {
          failure: validation.failure,
          steps: validation.steps,
        }
      )

      const repaired = await attemptTargetedRepair({
        jobId: input.jobId,
        prompt: input.prompt,
        files: validation.files,
        validationError: validation.failure?.message || "Validation lifecycle failed",
        repairAttempt,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
        promptLanguage,
        signal: input.signal,
      })

      workingFiles = repaired.files
      await transition(
        input.jobId,
        "validating",
        `Revalidating repaired artifacts ${repairAttempt}/${MAX_REPAIR_ATTEMPTS}`,
        Math.min(90, 76 + repairAttempt * 5),
        {
          repaired: repaired.repaired,
          parsedFileCount: repaired.parsedFileCount,
          addedPackages: repaired.addedPackages,
          normalizedPackages: repaired.normalizedPackages,
        }
      )

      validation = await runValidationLifecycle({
        jobId: input.jobId,
        projectId: input.projectId,
        prompt: input.prompt,
        files: workingFiles,
        plan,
        signal: input.signal,
        emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
      })
    }

    workingFiles = validation.files
    metrics.previewStatus = validation.previewStatus
    metrics.previewError = validation.failure?.message || null
    metrics.validationLifecycle = {
      ok: validation.ok,
      repairAttempts: repairAttempt,
      steps: validation.steps,
      sandboxValidation: validation.sandboxValidation,
      failure: validation.failure || null,
    }

    if (!validation.ok) {
      log("warn", "Generation validation lifecycle failed", {
        jobId: input.jobId,
        projectId: input.projectId,
        repairAttempts: repairAttempt,
        failure: validation.failure,
      })
      throw new Error(validation.failure?.message || "Validation lifecycle failed")
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    await transition(input.jobId, "persisting", "Persisting validated project artifacts", 94, {
      repairAttempts: repairAttempt,
      validationSteps: validation.steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
      })),
    })

    const saveResult = await ProjectFilePersistenceService.saveBufferedArtifacts({
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
    })

    await GenerationJobService.update(input.jobId, {
      metrics,
      previewUrl: validation.previewUrl,
    })
    await GenerationJobService.markCompleted(input.jobId, saveResult.historyId, validation.previewUrl)

    return {
      historyId: saveResult.historyId,
      files: workingFiles,
      previewUrl: validation.previewUrl,
    }
  } catch (error) {
    const cancelledBySignal =
      error instanceof Error && error.message === "GENERATION_JOB_CANCELLED"

    if (error instanceof GenerationJobCancelledError || cancelledBySignal) {
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
