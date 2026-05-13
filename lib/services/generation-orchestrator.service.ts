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
import { normalizePreviewContext } from "@/lib/ai/preview-context"
import { compileProject } from "@/lib/preview/module-resolution"
import { startRuntimeSandbox, type SandboxValidationStep } from "@/lib/sandbox/runtime"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { GenerationJobCancelledError, GenerationJobService, type GenerationJobStage } from "@/lib/services/generation-job.service"
import { GenerationQualityService, type GenerationQualityStage } from "@/lib/services/generation-quality.service"
import {
  buildBlueprintInstructionBlock,
  buildBlueprintSeedFiles,
  classifyControlledAppType,
  getControlledAppBlueprint,
  validateBlueprintConstraints,
  type ControlledAppBlueprint,
  type ControlledAppType,
} from "@/lib/ai/app-blueprints"
import {
  buildPartialEditInstructionBlock,
  buildPartialEditPlan,
  filterFilesForPartialEdit,
  type PartialEditPlan,
} from "@/lib/ai/edit-planner"
import { log } from "@/lib/logging"

type GenerationPlannerFile = {
  path: string
  reason: string
  action: "create_or_update"
}

type GenerationPlan = {
  objective: string
  appType: ControlledAppType
  editPlan: PartialEditPlan
  blueprint: {
    label: string
    requiredFiles: string[]
    stack: string[]
  }
  filePlan: GenerationPlannerFile[]
  architecturePlan: string[]
  dependencyPlan: string[]
  fileGraphPlan: string[]
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
  previewContext?: unknown
  persistenceKey?: string | null
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
  | "dependency-install"
  | "typecheck"
  | "lint"
  | "build"
  | "runtime-smoke"

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

function buildGenerationPlan(input: {
  prompt: string
  existingFiles: GeneratedFile[]
  collaborationMode?: string | null
  previewContext?: unknown
}) {
  const previewContext = normalizePreviewContext(input.previewContext)
  const classification = classifyPrompt(input.prompt, {
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode || undefined,
    previewError: previewContext?.previewError?.message || null,
  })
  const editPlan = buildPartialEditPlan({
    prompt: input.prompt,
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode,
    previewContext,
  })
  const appType = classifyControlledAppType(input.prompt)
  const blueprint = getControlledAppBlueprint(appType)
  const trimmed = trimContextForGeneration({
    prompt: input.prompt,
    files: input.existingFiles,
    activeFilePath: previewContext?.activeFilePath || undefined,
    previewErrorFile: previewContext?.previewError?.filename || undefined,
    layer: classification === "simple_ui" ? "fast" : "builder",
  })

  const plannedByPath = new Map<string, GenerationPlannerFile>()

  if (editPlan.mode === "partial") {
    for (const filePath of [...editPlan.targetPaths, ...editPlan.allowedNewPaths]) {
      const path = normalizePath(filePath)
      plannedByPath.set(path, {
        path,
        reason: editPlan.targetPaths.includes(path)
          ? `Partial ${editPlan.intent} target selected by edit planner`
          : `Partial ${editPlan.intent} may create this file if needed`,
        action: "create_or_update",
      })
    }
  } else {
    for (const filePath of blueprint.requiredFiles.slice(0, 10)) {
      plannedByPath.set(normalizePath(filePath), {
        path: normalizePath(filePath),
        reason: `${blueprint.label} blueprint requires this file for deployable generation`,
        action: "create_or_update",
      })
    }

    for (const file of trimmed.files.slice(0, 8)) {
      const path = normalizePath(file.path)
      if (!plannedByPath.has(path)) {
        plannedByPath.set(path, {
          path,
          reason: "Relevant existing file selected by context ranking",
          action: "create_or_update",
        })
      }
    }
  }

  const filePlan = Array.from(plannedByPath.values()).slice(0, editPlan.maxSlices)

  if (!filePlan.some((item) => /^app\/page\.(tsx|ts|jsx|js)$/i.test(item.path))) {
    const shouldAddHomePage = editPlan.mode === "full" || input.existingFiles.length === 0
    if (shouldAddHomePage) {
      filePlan.unshift({
        path: "app/page.tsx",
        reason: "Primary visible entrypoint should be generated or refined first",
        action: "create_or_update",
      })
    }
  }

  return {
    objective: classification,
    appType,
    editPlan,
    blueprint: {
      label: blueprint.label,
      requiredFiles: blueprint.requiredFiles,
      stack: blueprint.dependencyPolicy.stack,
    },
    filePlan,
    architecturePlan: blueprint.architectureRules,
    dependencyPlan: [
      "Use only the locked Swift stack.",
      `Allowed packages: ${blueprint.dependencyPolicy.allowedExternalPackages.join(", ")}`,
      "Do not introduce alternate frameworks, databases, routers, or package managers.",
    ],
    fileGraphPlan: filePlan.map((file) => `${file.path}: ${file.reason}`),
    contextBudget: {
      ...trimmed.budget,
      usedFiles: trimmed.files.length,
      usedChars: trimmed.totalChars,
    },
  } satisfies GenerationPlan
}

function shouldSeedBlueprint(existingFiles: GeneratedFile[]) {
  if (existingFiles.length === 0) return true

  const paths = new Set(existingFiles.map((file) => normalizePath(file.path)))
  return !paths.has("app/page.tsx") || !paths.has("package.json") || !paths.has("prisma/schema.prisma")
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
  blueprint: ControlledAppBlueprint
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
    buildBlueprintInstructionBlock(input.blueprint),
    "",
    buildPartialEditInstructionBlock(input.plan.editPlan),
    "",
    "EXECUTION_RULES:",
    "- Work only on the requested file slice and directly related imports.",
    "- Return only changed files.",
    "- Prefer patch-safe, deterministic updates.",
    "- Preserve stable files from the starter template unless this slice requires a focused update.",
    "- Keep the app deployable after this slice: no unresolved imports, no forbidden stack drift.",
    `- Current file objective: ${input.target.path}`,
    `- Why this file matters: ${input.target.reason}`,
    `- Planned objective: ${input.plan.objective}`,
    `- Controlled app type: ${input.plan.appType}`,
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
  if (step.name === "install") {
    return {
      name: "dependency-install",
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
  if (failed?.name === "install") {
    return "dependency-install"
  }
  if (failed?.name === "typecheck" || failed?.name === "lint" || failed?.name === "build") {
    return failed.name
  }

  return "runtime-smoke"
}

async function runValidationLifecycle(input: {
  jobId: string
  projectId: string
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
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
  const partialRequiredFiles =
    input.plan.editPlan.mode === "partial"
      ? input.blueprint.requiredFiles.filter((filePath) => {
          const normalized = normalizePath(filePath)
          return (
            normalized === "app/layout.tsx" ||
            normalized === "app/page.tsx" ||
            normalized === "package.json" ||
            normalized === "prisma/schema.prisma" ||
            input.plan.editPlan.targetPaths.includes(normalized) ||
            input.plan.editPlan.allowedNewPaths.includes(normalized)
          )
        })
      : input.blueprint.requiredFiles
  const blueprintValidation = validateBlueprintConstraints(files, input.blueprint, {
    requiredFiles: partialRequiredFiles,
  })
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

  if (!blueprintValidation.ok) {
    if (blueprintValidation.missingRequiredFiles.length > 0) {
      staticFailures.push(`Missing blueprint files: ${blueprintValidation.missingRequiredFiles.join(", ")}`)
    }
    if (blueprintValidation.forbiddenFiles.length > 0) {
      staticFailures.push(`Forbidden stack drift files: ${blueprintValidation.forbiddenFiles.join(", ")}`)
    }
  }

  if (staticFailures.length > 0) {
    const message = staticFailures.join("; ")
    const data = {
      appType: input.plan.appType,
      coverage: fullstack.coverage,
      missingCategories: fullstack.missingCategories,
      fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
      blueprint: {
        missingRequiredFiles: blueprintValidation.missingRequiredFiles,
        forbiddenFiles: blueprintValidation.forbiddenFiles,
      },
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
    appType: input.plan.appType,
    coverage: fullstack.coverage,
    missingCategories: fullstack.missingCategories,
    fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
    blueprintRequiredFiles: input.blueprint.requiredFiles.length,
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
    const runtimeFailed =
      preview.runtimeVerification && !preview.runtimeVerification.ok
          ? {
            category: preview.runtimeVerification.failureCategory || "unknown",
            error: preview.runtimeVerification.error || null,
          }
        : null
    if (step === "runtime-smoke") {
      recordStep("runtime-smoke", "failed", "required", stepStartedAt, preview.error, {
        sandboxStatus: preview.status,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-80),
      })
    } else {
      recordStep(step, "failed", "required", stepStartedAt, preview.error, {
        sandboxStatus: preview.status,
        sandboxValidation: preview.validation,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-80),
      })
    }
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

  recordStep("runtime-smoke", "passed", "required", stepStartedAt, undefined, {
    sandboxStatus: preview.status,
    runtimeVerification: preview.runtimeVerification,
  })

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
  blueprint: ControlledAppBlueprint
  editPlan: PartialEditPlan
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
    buildBlueprintInstructionBlock(input.blueprint),
    "",
    buildPartialEditInstructionBlock(input.editPlan),
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
  const scoped = filterFilesForPartialEdit(parsed.files, input.editPlan)
  const mergedFiles = mergeGeneratedFiles(currentFiles, scoped.acceptedFiles)
  const normalized = normalizeGeneratedDependencies(mergedFiles)

  return {
    files: normalized.files,
    repaired: scoped.acceptedFiles.length > 0,
    parsedFileCount: parsed.files.length,
    acceptedFileCount: scoped.acceptedFiles.length,
    rejectedFiles: scoped.rejectedFiles.map((file) => file.path).slice(0, 8),
    normalizedPackages: normalized.normalizedPackages,
    addedPackages: normalized.addedPackages,
  }
}

function mapLifecycleFailureToQualityStage(step?: ValidationLifecycleStep | null): GenerationQualityStage {
  if (!step) return "unknown"
  if (step === "static") return "static-validation"
  if (step === "dependency-install") return "dependency-planning"
  if (step === "preview-compile") return "preview-compile"
  if (step === "typecheck") return "typecheck"
  if (step === "lint") return "lint"
  if (step === "build") return "build"
  if (step === "runtime-smoke") return "runtime-smoke"
  if (step === "normalize") return "code-generation"
  return "unknown"
}

function sumStepDurations(steps: ValidationLifecycleStepResult[]) {
  return steps.reduce((sum, step) => sum + Math.max(0, step.durationMs || 0), 0)
}

async function recordGenerationQuality(input: {
  jobId: string
  projectId: string
  appType: ControlledAppType
  status: "completed" | "failed" | "cancelled"
  validation?: ValidationLifecycleResult | null
  repairAttempts: number
  providerLatencyMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  totalLatencyMs: number
  failureStage?: GenerationQualityStage | string | null
  failureCode?: string | null
  metadata?: Record<string, unknown> | null
}) {
  const job = await GenerationJobService.findById(input.jobId)
  if (!job) return

  const steps = input.validation?.steps || []
  const buildPassed = steps.some((step) => step.name === "build" && step.status === "passed")
  const runtimePassed = steps.some((step) => step.name === "runtime-smoke" && step.status === "passed")
  const validationLatencyMs = sumStepDurations(steps)

  await GenerationQualityService.recordSummary({
    jobId: input.jobId,
    userId: job.userId,
    projectId: input.projectId,
    appType: input.appType,
    status: input.status,
    failureStage:
      input.failureStage ||
      (input.validation?.failure ? mapLifecycleFailureToQualityStage(input.validation.failure.step) : null),
    failureCode: input.failureCode || input.validation?.failure?.message?.slice(0, 180) || null,
    buildPassed,
    runtimePassed,
    repairSucceeded: input.repairAttempts > 0 && input.status === "completed",
    deployValidated: false,
    repairAttempts: input.repairAttempts,
    providerLatencyMs: input.providerLatencyMs,
    validationLatencyMs,
    totalLatencyMs: input.totalLatencyMs,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    metadata: {
      ...(input.metadata || {}),
      lifecycleSteps: steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
        durationMs: step.durationMs,
      })),
      previewStatus: input.validation?.previewStatus || null,
    },
  })
}

export async function executeGenerationJob(
  input: ExecuteGenerationJobInput,
  deps: ExecuteGenerationJobDeps
) {
  const promptLanguage = input.promptLanguage || "id"
  const jobStartedAt = performance.now()
  const metrics: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
  }
  let plan: GenerationPlan | null = null
  let blueprint: ControlledAppBlueprint | null = null
  let validation: ValidationLifecycleResult | null = null
  let repairAttempt = 0
  let providerLatencyMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  try {
    await GenerationJobService.transition(input.jobId, {
      type: "job.stage.planning",
      status: "running",
      stage: "planning",
      label: "Planning app intent",
      progress: 5,
      startedAt: new Date(),
      message: "Planning app intent",
    })
    await GenerationJobService.assertNotCancelled(input.jobId)

    const existingFiles = await deps.loadProjectFiles(input.projectId)
    plan = buildGenerationPlan({
      prompt: input.prompt,
      existingFiles,
      collaborationMode: input.collaborationMode,
      previewContext: input.previewContext,
    })
    blueprint = getControlledAppBlueprint(plan.appType)
    await GenerationJobService.transition(input.jobId, {
      type: "job.plan.ready",
      status: "running",
      stage: "planning",
      label: "Architecture plan ready",
      progress: 10,
      plan,
      context: {
        fileCount: existingFiles.length,
      },
      message: "Architecture plan ready",
      data: {
        objective: plan.objective,
        appType: plan.appType,
        blueprint: plan.blueprint,
        editPlan: {
          mode: plan.editPlan.mode,
          intent: plan.editPlan.intent,
          targetPaths: plan.editPlan.targetPaths,
          allowedNewPaths: plan.editPlan.allowedNewPaths,
        },
        filePlan: plan.filePlan,
      },
    })

    const seededFiles = shouldSeedBlueprint(existingFiles)
      ? buildBlueprintSeedFiles({
          prompt: input.prompt,
          appType: plan.appType,
          projectName: plan.blueprint.label,
        })
      : []
    let workingFiles = seededFiles.length > 0 ? mergeGeneratedFiles(seededFiles, existingFiles) : [...existingFiles]

    if (seededFiles.length > 0) {
      await transition(input.jobId, "scaffolding", "Applying known-good starter architecture", 14, {
        appType: plan.appType,
        seededFileCount: seededFiles.length,
      })
    }

    for (let index = 0; index < plan.filePlan.length; index += 1) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      const target = plan.filePlan[index]
      const providerStartedAt = performance.now()
      const response = await runProviderAttempt({
        jobId: input.jobId,
        prompt: buildSlicePrompt({
          prompt: input.prompt,
          plan,
          blueprint,
          existingFiles: workingFiles,
          target,
        }),
        purpose: "generate",
        selectedModel: input.selectedModel,
        promptLanguage,
        signal: input.signal,
      })
      providerLatencyMs += Math.round(performance.now() - providerStartedAt)
      promptTokens += Math.max(0, response.tokenUsage?.promptTokens || 0)
      completionTokens += Math.max(0, response.tokenUsage?.completionTokens || 0)
      totalTokens += Math.max(0, response.tokenUsage?.totalTokens || 0)

      const parsed = parseGeneratedArtifact(response.message)
      const scoped = filterFilesForPartialEdit(parsed.files, plan.editPlan)

      workingFiles = mergeGeneratedFiles(workingFiles, scoped.acceptedFiles)
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files

      await transition(
        input.jobId,
        "parsing",
        `Generating controlled file slice ${index + 1}/${plan.filePlan.length}`,
        Math.min(55, 15 + Math.round(((index + 1) / Math.max(1, plan.filePlan.length)) * 35)),
        {
          target: target.path,
          parseFileCount: parsed.files.length,
          acceptedFileCount: scoped.acceptedFiles.length,
          rejectedFileCount: scoped.rejectedFiles.length,
          rejectedFiles: scoped.rejectedFiles.map((file) => file.path).slice(0, 8),
          addedPackages: normalized.addedPackages,
        }
      )
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    validation = await runValidationLifecycle({
      jobId: input.jobId,
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      plan,
      blueprint,
      signal: input.signal,
      emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
    })

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
        blueprint,
        editPlan: plan.editPlan,
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
          acceptedFileCount: repaired.acceptedFileCount,
          rejectedFiles: repaired.rejectedFiles,
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
        blueprint,
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
    metrics.quality = {
      appType: plan.appType,
      editMode: plan.editPlan.mode,
      editIntent: plan.editPlan.intent,
      targetFileCount: plan.editPlan.targetPaths.length,
      preservedFileCount: plan.editPlan.preservePaths.length,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
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
      idempotencyKey: input.persistenceKey,
    })

    await GenerationJobService.update(input.jobId, {
      metrics,
      previewUrl: validation.previewUrl,
    })
    await recordGenerationQuality({
      jobId: input.jobId,
      projectId: input.projectId,
      appType: plan.appType,
      status: "completed",
      validation,
      repairAttempts: repairAttempt,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      totalLatencyMs: performance.now() - jobStartedAt,
      metadata: {
        objective: plan.objective,
        editPlan: {
          mode: plan.editPlan.mode,
          intent: plan.editPlan.intent,
          targetPaths: plan.editPlan.targetPaths,
          allowedNewPaths: plan.editPlan.allowedNewPaths,
          preservedFileCount: plan.editPlan.preservePaths.length,
        },
        fileCount: workingFiles.length,
      },
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
      await recordGenerationQuality({
        jobId: input.jobId,
        projectId: input.projectId,
        appType: plan?.appType || classifyControlledAppType(input.prompt),
        status: "cancelled",
        validation,
        repairAttempts: repairAttempt,
        providerLatencyMs,
        promptTokens,
        completionTokens,
        totalTokens,
        totalLatencyMs: performance.now() - jobStartedAt,
        failureStage: "code-generation",
        failureCode: "cancelled",
      }).catch(() => null)
      await GenerationJobService.markCancelled(input.jobId, "Generation cancelled")
      throw error
    }

    const serialized = serializeError(error)
    await GenerationJobService.update(input.jobId, {
      diagnostics: serialized,
      metrics,
    })
    await recordGenerationQuality({
      jobId: input.jobId,
      projectId: input.projectId,
      appType: plan?.appType || classifyControlledAppType(input.prompt),
      status: "failed",
      validation,
      repairAttempts: repairAttempt,
      providerLatencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      totalLatencyMs: performance.now() - jobStartedAt,
      failureStage: validation?.failure ? mapLifecycleFailureToQualityStage(validation.failure.step) : "unknown",
      failureCode: serialized.message,
      metadata: {
        errorName: serialized.name,
        editPlan: plan
          ? {
              mode: plan.editPlan.mode,
              intent: plan.editPlan.intent,
              targetPaths: plan.editPlan.targetPaths,
              allowedNewPaths: plan.editPlan.allowedNewPaths,
            }
          : null,
      },
    }).catch(() => null)
    await GenerationJobService.markFailed(input.jobId, serialized.message)
    throw error
  }
}
