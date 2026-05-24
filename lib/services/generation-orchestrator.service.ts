import { performance } from "node:perf_hooks"
import { createHash } from "node:crypto"
import type { GeneratedFile } from "@/lib/types"
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
import { validateFrontendCompleteness } from "@/lib/ai/frontend-completeness-validator"
import { parseGeneratedArtifact } from "@/lib/ai/generated-artifact"
import {
  createDeveloperGenerationDiagnostics,
  persistFailedGenerationArtifacts,
  persistInvalidArtifactReport,
  persistRenderFailureReport,
  persistRuntimeFailureReport,
  recordDeveloperDiagnostic,
  summarizeArtifactPayload,
  summarizeGeneratedFiles,
} from "@/lib/ai/developer-diagnostics"
import { publicGenerationStructureErrorMessage } from "@/lib/ai/runtime-contracts"
import { ProviderRouter, SwiftProviderFailureError } from "@/lib/ai/provider-router"
import { getSwiftTierConfig } from "@/lib/ai/swift-tiers"
import { normalizePreviewContext } from "@/lib/ai/preview-context"
import { compileProject } from "@/lib/preview/module-resolution"
import { runRuntimeCommand, startRuntimeSandbox, type RuntimeCommandName, type SandboxValidationStep } from "@/lib/sandbox/runtime"
import { ProjectFilePersistenceService } from "@/lib/services/project-file-persistence.service"
import { ProjectFilesystemService, type ProjectFileManifest } from "@/lib/services/project-filesystem.service"
import { loadProjectState, buildProjectStatePromptBlock } from "@/lib/project-state/engine"
import { buildProjectDependencyGraph } from "@/lib/project-state/dependency-graph"
import { artifactToPatchOperations, applyProjectPatchOperations, MAX_CHANGED_FILES_PER_REQUEST } from "@/lib/project-state/diff-patch-engine"
import { runDedicatedUserSandbox } from "@/lib/project-state/sandbox-isolation"
import { GenerationJobCancelledError, GenerationJobService, type GenerationJobStage } from "@/lib/services/generation-job.service"
import { OrchestrationRuntimeService, type TraceIds } from "@/lib/services/orchestration-runtime.service"
import { GenerationQualityService, type GenerationQualityStage } from "@/lib/services/generation-quality.service"
import {
  buildBlueprintInstructionBlock,
  buildDynamicSeedDirective,
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
import { analyzePromptIntent, buildIntentInstructionBlock, type IntentAnalysis } from "@/lib/ai/intent-analyzer"
import { isHardFrontendOnlyPrompt, parseStructuredIntent, type SwiftStructuredIntent } from "@/lib/ai/architecture-intent"
import {
  buildArchitectureInstructionBlock,
  buildArchitecturePlan,
  type SwiftArchitecturePlan,
} from "@/lib/ai/architecture-planner"
import {
  buildArchitectureDependencyGraph,
  buildPersistentArchitectureSnapshot,
  buildProjectMemoryGraph,
  type SwiftDependencyGraph,
  type SwiftProjectMemoryGraph,
} from "@/lib/ai/project-memory-graph"
import { validateArchitectureFiles } from "@/lib/ai/architecture-validator"
import { validateGeneratedUXQuality } from "@/lib/ai/product-ux-planner"
import {
  appendRepairPath,
  assertSoftwareOrchestrationReady,
  buildRoleInstructionBlock,
  createSoftwareOrchestration,
  markCommitStatus,
  markOrchestrationValidation,
  markPreviewStatus,
  markScopeRejections,
  validateProjectScaffold,
  type SoftwareOrchestrationDiagnostics,
  type SoftwareOrchestrationRole,
} from "@/lib/ai/software-orchestration"
import {
  applyDeterministicIncrementalPatch,
  buildScopedEditResult,
  buildIncrementalEditPlan,
  parseRepairPayload,
  validateIncrementalPatch,
  type GenerationMode,
  type IncrementalEditPlan,
} from "@/lib/ai/incremental-edit"
import { validateGeneratedPath } from "@/lib/ai/file-policy"
import { buildImportGraph, getTransitiveImpactPaths } from "@/lib/ai/import-graph"
import {
  analyzeComponentRegistryUsage,
  componentRegistryPromptPayload,
  ensureComponentRegistryFiles,
  selectedRegistryComponentsForTemplate,
  validateComponentContracts,
} from "@/lib/ai/component-registry"
import {
  autoRepairAdjacentJsxFragments,
  validateRuntimeImports,
  validateRuntimeSyntax,
} from "@/lib/ai/runtime-tsx-validator"
import { repairRuntimeImportGraph } from "@/lib/ai/import-repair"
import { executeGeneratedTaskGraph } from "@/lib/ai/task-graph-executor"
import { log } from "@/lib/logging"
import { createCorrelationIds, traceError, traceExecution } from "@/lib/observability/execution-tracer"
import { warnIfSlow } from "@/lib/observability/performance-monitor"
import {
  recordBuildDuration,
  recordOpenRouterLatency,
  recordRetry,
  recordValidationResult,
  updateAiTask,
} from "@/lib/observability/runtime-metrics"
import {
  captureRuntimeError,
  diagnoseRuntimeError,
  recordGenerationStageTelemetry,
  recordRepairStageTelemetry,
  recordRuntimeRecoveryEvent,
} from "@/lib/observability/runtime-recovery"
import { timeoutConfig } from "@/lib/timeouts"
import { selectIntentTemplate } from "@/lib/templates/intent-library"
import type { CollaborationMode } from "@/lib/ai/collaboration-mode"

type GenerationPlannerFile = {
  path: string
  reason: string
  action: "create_or_update"
  stage?: StagedGenerationPhase
}

type StagedGenerationPhase = "scaffold" | "routes" | "components" | "supabase" | "turso" | "support"

type AgentWorkflowAction = {
  action: "create" | "modify" | "delete"
  file: string
  reason?: string
}

type AgentWorkflowMemoryEntry = {
  iteration: number
  changedFiles: string[]
  errors: Array<{
    step?: string
    message: string
  }>
  fixes: string[]
}

type AgentWorkflowObservation = {
  prompt: string
  activeTask: string
  targetPaths: string[]
  blueprint: {
    label: string
    requiredFiles: string[]
    stack: string[]
  }
  selectedFiles: Array<{ path: string; reason: string }>
  fileContext: Array<{ path: string; language: GeneratedFile["language"]; content: string }>
  packageJson: {
    exists: boolean
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    parseError: string | null
  }
  dependencies: DependencyMap
  prismaSchema: {
    exists: boolean
    path: string | null
    bytes: number
  }
  buildLogs: string[]
  previousAttempts: AgentWorkflowMemoryEntry[]
}

type GenerationPlan = {
  objective: string
  generationMode: GenerationMode
  appType: ControlledAppType
  intent: IntentAnalysis
  structuredIntent: SwiftStructuredIntent
  incrementalEdit: IncrementalEditPlan
  editPlan: PartialEditPlan
  productionMode: "preview" | "full_frontend" | "production_fullstack"
  maxFilesThisPass: number
  blueprint: {
    label: string
    requiredFiles: string[]
    stack: string[]
  }
  filePlan: GenerationPlannerFile[]
  allowedFileScope: AllowedFileScopeContract
  architecturePlan: string[]
  architecture: SwiftArchitecturePlan
  projectMemory: SwiftProjectMemoryGraph
  dependencyGraph: SwiftDependencyGraph
  orchestration: SoftwareOrchestrationDiagnostics
  dependencyPlan: string[]
  fileGraphPlan: string[]
  agentTasks: string[]
  actionPlan: AgentWorkflowAction[]
  contextBudget: {
    maxFiles: number
    maxCharsPerFile: number
    maxTotalChars: number
    usedFiles: number
    usedChars: number
  }
}

type AllowedFileScopeContract = {
  kind: "swift_allowed_file_scope"
  allowedPaths: string[]
  targetPaths: string[]
  existingPaths: string[]
  helperPolicy: "explicit_only"
  blockedHelperPatterns: string[]
  reason: string
}

type ExecuteGenerationJobInput = {
  jobId: string
  userId?: string
  projectId: string
  prompt: string
  selectedModel: string
  promptLanguage?: "id" | "en"
  collaborationMode?: CollaborationMode
  previewContext?: unknown
  persistenceKey?: string | null
  correlationId?: string
  traceId?: string
  executionChainId?: string
  signal?: AbortSignal
}

type ExecuteGenerationJobDeps = {
  loadProjectFiles: (projectId: string) => Promise<GeneratedFile[]>
  loadGenerationHistoryCount?: (projectId: string) => Promise<number>
  loadProjectMemoryJson?: (projectId: string) => Promise<string | null>
}

const MAX_AGENT_ITERATIONS = 5
const MAX_REPAIR_ATTEMPTS = 3
const PREVIEW_FOUNDATION_FILE_LIMIT = 3
const FULL_FRONTEND_FILE_LIMIT = 15
const FULL_FRONTEND_BATCH_SIZE = 5
const PRODUCTION_FULLSTACK_FILE_LIMIT = 16
const PRODUCTION_FULLSTACK_BATCH_SIZE = 5
const MINIMAL_RUNNABLE_FALLBACK_REQUIRED_FILES = [
  "package.json",
  "tsconfig.json",
  "app/page.tsx",
  "app/layout.tsx",
  "components/loading-skeleton.tsx",
  "components/site-footer.tsx",
  "lib/data.ts",
]
const MINIMAL_RUNNABLE_FALLBACK_SUPPORT_FILES = [
  "app/globals.css",
  "components/site-header.tsx",
  "components/cta-section.tsx",
  "sections/hero-section.tsx",
  "sections/features-section.tsx",
  "sections/faq-section.tsx",
]
const MAX_FILES_PER_REPAIR = 3
const MIN_RENDER_SCORE_TO_PERSIST = 100

type RuntimeFailureCategory =
  | "hydration_failed"
  | "import_failed"
  | "dependency_failed"
  | "route_failed"
  | "environment_failed"
  | "sandbox_failed"
  | "rendering_failed"

type RenderingFailureCategory =
  | "client_server_boundary_failed"
  | "provider_missing"
  | "props_mismatch"
  | "async_render_failed"
  | "layout_failed"
  | "component_tree_failed"
  | "state_initialization_failed"

type ValidationLifecycleStep =
  | "normalize"
  | "tsx-validation"
  | "import-validation"
  | "component-contracts"
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

class CompileGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompileGateError"
  }
}

type ProjectStateCommitDiagnostics = {
  generatedFileCount: number
  committedFileCount: number
  persistedSnapshotId: string
  failedWritePaths: string[]
  requiredFilesMissing: string[]
  manifest: ProjectFileManifest
}

type RepairTerminationReason =
  | "max_retries_exceeded"
  | "repeated_identical_artifact"
  | "validator_deadlock"
  | "empty_repair_output"
  | "timeout"
  | "malformed_repair_payload"
  | "repair_score_regressed"

type RemoteSandboxResponse = {
  status?: string | null
  previewUrl?: string | null
  logs?: string[] | null
  error?: string | null
}

const sandboxServiceUrl = () => (process.env.SANDBOX_SERVICE_URL || "").replace(/\/+$/, "")
const sandboxServiceToken = () => process.env.SANDBOX_SERVICE_TOKEN || ""
const isProductionVercel = () => process.env.NODE_ENV === "production" && Boolean(process.env.VERCEL)

function canUseRemoteSandboxService() {
  const url = sandboxServiceUrl()
  const token = sandboxServiceToken()
  if (!url || !token) return false
  if (!process.env.VERCEL && process.env.SWIFT_USE_REMOTE_SANDBOX !== "true") return false
  return true
}

function runtimeLogText(value: string, maxLength = 12000) {
  const raw = String(value || "")
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...<truncated:${raw.length - maxLength}>` : raw
}

function hashText(value: string) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16)
}

function filePathList(files: GeneratedFile[], limit = 80) {
  return files.map((file) => normalizePath(file.path)).slice(0, limit)
}

function missingNormalizedPaths(files: GeneratedFile[], requiredPaths: string[]) {
  const present = new Set(files.map((file) => normalizePath(file.path)))
  return uniquePaths(requiredPaths).filter((path) => !present.has(normalizePath(path)))
}

function missingArtifactTargetPaths(artifact: ReturnType<typeof parseGeneratedArtifact>, requiredPaths: string[]) {
  const present = new Set([
    ...artifact.files.map((file) => normalizePath(file.path)),
    ...(artifact.taskGraph?.operations || []).map((operation) => normalizePath(operation.path)),
  ])
  return uniquePaths(requiredPaths).filter((path) => !present.has(normalizePath(path)))
}

function buildPersistedProjectStateSnapshot(input: {
  files: GeneratedFile[]
  validation?: ValidationLifecycleResult | null
}) {
  const manifest = ProjectFilesystemService.buildManifest(input.files)
  return {
    files: manifest.paths,
    dependencyGraph: buildProjectDependencyGraph(input.files),
    buildStatus: {
      status: input.validation?.ok ? "passed" : input.validation ? "failed" : "unknown",
      checkedAt: new Date().toISOString(),
      failingFiles: input.validation?.failure?.data?.filePath
        ? [String(input.validation.failure.data.filePath)]
        : [],
      summary: input.validation?.failure?.message || null,
    },
    generatedArtifacts: {
      lastSnapshotAt: new Date().toISOString(),
    },
    metadata: {
      manifest,
      maxChangedFilesPerRequest: MAX_CHANGED_FILES_PER_REQUEST,
      updatedAt: new Date().toISOString(),
    },
  }
}

async function startConfiguredSandboxService(input: {
  projectId: string
  files: GeneratedFile[]
  signal?: AbortSignal
}): Promise<RemoteSandboxResponse> {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  const token = sandboxServiceToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const timeoutMs = timeoutConfig.sandboxServiceMs
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortRequest = () => controller.abort()
  input.signal?.addEventListener("abort", abortRequest, { once: true })

  let response: Response
  try {
    response = await fetch(
      `${sandboxServiceUrl()}/sandbox/${encodeURIComponent(input.projectId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ files: input.files }),
        signal: controller.signal,
        cache: "no-store",
      }
    )
  } catch (error) {
    return {
      status: "error",
      previewUrl: null,
      logs: [],
      error:
        error instanceof Error && error.name === "AbortError"
          ? `Sandbox service request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Sandbox service request failed",
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", abortRequest)
  }

  const data = (await response.json().catch(() => ({
    status: "error",
    previewUrl: null,
    logs: [],
    error: `Sandbox service returned non-JSON response (${response.status})`,
  }))) as RemoteSandboxResponse

  if (!response.ok) {
    return {
      status: data.status || "error",
      previewUrl: data.previewUrl || null,
      logs: Array.isArray(data.logs) ? data.logs : [],
      error: data.error || `Sandbox service failed with HTTP ${response.status}`,
    }
  }

  return {
    status: data.status || null,
    previewUrl: data.previewUrl || null,
    logs: Array.isArray(data.logs) ? data.logs : [],
    error: data.error || null,
  }
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

function publicGenerationErrorMessage(error: unknown) {
  if (error instanceof SwiftProviderFailureError) {
    return error.userMessage
  }

  return publicGenerationStructureErrorMessage(error)
}

function publicArtifactParseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^MALFORMED_GENERATED_ARTIFACT:/, "")
    .replace(/^schema:/, "")
    .trim() || "Invalid artifact JSON"
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Generation aborted before completion")
  }
}

function shouldUseProductionFullStackMode(prompt: string, input?: { collaborationMode?: CollaborationMode | null }) {
  const text = `${prompt}\n${input?.collaborationMode || ""}`.toLowerCase()
  const explicitFullStack =
    /\b(full\s*stack|fullstack|backend|database|db|prisma|postgres|api route|route handler|crud|auth|login|register|role|rbac|admin|pengelola|user|payment|stripe|webhook|integrasi|integration|bpjs|klinik|clinic|rumah sakit|hospital|pasien|patient|dokter|doctor|appointment|janji temu|jadwal)\b/i.test(text)
  const explicitBuild =
    /\b(buat|bikin|generate|build|jadikan|create|website|web|app|aplikasi|desain|rancang|struktur)\b/i.test(text)

  return explicitFullStack && explicitBuild
}

function productionRequiredFiles(blueprint: ControlledAppBlueprint, prompt: string) {
  const text = prompt.toLowerCase()
  const coreFiles = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "prisma/schema.prisma",
    "package.json",
  ]

  if (blueprint.appType === "clinic_management") {
    const clinicCore = [
      ...coreFiles,
      "app/api/patients/route.ts",
      "app/api/doctors/route.ts",
      "app/api/appointments/route.ts",
      "app/api/auth/route.ts",
      "app/api/bpjs/route.ts",
      "lib/services/clinic.service.ts",
      "lib/services/bpjs.service.ts",
      "components/clinic-dashboard.tsx",
    ]
    return Array.from(new Set(clinicCore)).slice(0, PRODUCTION_FULLSTACK_FILE_LIMIT)
  }

  const genericSupportFiles = new Set([
    "app/api/health/route.ts",
    "components/build-status-panel.tsx",
    "lib/services/project.service.ts",
  ])
  const required = new Set<string>(coreFiles)
  const domainFiles = blueprint.requiredFiles
    .map(normalizePath)
    .filter((filePath) => !required.has(filePath) && !genericSupportFiles.has(filePath))

  for (const filePath of domainFiles) {
    required.add(filePath)
  }

  if (/\b(admin|pengelola|staff|role|rbac|user|login|auth)\b/i.test(text)) {
    required.add("app/admin/page.tsx")
    required.add("app/api/admin/users/route.ts")
    required.add("app/api/auth/route.ts")
  }

  if (/\b(klinik|clinic|rumah sakit|hospital|pasien|patient|dokter|doctor|bpjs|appointment|janji temu|jadwal)\b/i.test(text)) {
    required.add("app/dashboard/page.tsx")
    required.add("app/patients/page.tsx")
    required.add("app/doctors/page.tsx")
    required.add("app/appointments/page.tsx")
    required.add("app/api/patients/route.ts")
    required.add("app/api/doctors/route.ts")
    required.add("app/api/appointments/route.ts")
    required.add("app/api/auth/route.ts")
    required.add("app/api/bpjs/route.ts")
    required.add("lib/services/clinic.service.ts")
    required.add("components/clinic-dashboard.tsx")
    required.add("lib/hooks/use-clinic-data.ts")
  }

  if (/\b(bpjs)\b/i.test(text)) {
    required.add("app/api/bpjs/route.ts")
    required.add("app/api/integrations/bpjs/route.ts")
    required.add("lib/services/bpjs.service.ts")
    required.add("lib/services/bpjs.ts")
  }

  if (/\b(payment|payments|bayar|pembayaran|pakasir|stripe|midtrans|xendit|webhook)\b/i.test(text)) {
    required.add("app/api/payments/checkout/route.ts")
    required.add("app/api/payments/webhook/route.ts")
    required.add("lib/services/payment.service.ts")
  }

  if (/\b(api|integrasi|integration|connect|hubungkan|external api|third party)\b/i.test(text)) {
    required.add("app/api/integrations/route.ts")
    required.add("lib/services/integration.service.ts")
  }

  if (blueprint.appType === "simple_marketplace" || /\b(product|produk|marketplace|e-?commerce|seller|buyer|user|auth|login|admin)\b/i.test(text)) {
    required.add("app/api/products/route.ts")
    required.add("app/api/users/route.ts")
    required.add("lib/services/product.service.ts")
    required.add("lib/services/user.service.ts")
    required.add("prisma/schema.prisma")
  }

  for (const filePath of genericSupportFiles) {
    required.add(filePath)
  }

  return Array.from(required).slice(0, PRODUCTION_FULLSTACK_FILE_LIMIT)
}

function fullFrontendRequiredFiles(blueprint: ControlledAppBlueprint, prompt: string) {
  const text = prompt.toLowerCase()
  const required = new Set<string>([
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "components/site-header.tsx",
    "components/site-footer.tsx",
    "components/cta-section.tsx",
    "components/loading-skeleton.tsx",
    "lib/data.ts",
  ])

  if (/\b(dashboard|analytics|admin|panel|workspace)\b/i.test(text)) {
    required.add("components/dashboard-shell.tsx")
    required.add("components/metric-card.tsx")
    required.add("sections/analytics-overview.tsx")
    required.add("sections/activity-table.tsx")
  } else if (/\b(ecommerce|web toko|toko|shop|store|produk|product|marketplace)\b/i.test(text)) {
    required.add("sections/product-grid.tsx")
    required.add("sections/category-showcase.tsx")
    required.add("components/product-card.tsx")
    required.add("components/cart-summary.tsx")
  } else if (/\b(travel|destination|tour|trip|hotel|wisata)\b/i.test(text)) {
    required.add("sections/destination-grid.tsx")
    required.add("sections/travel-packages.tsx")
    required.add("components/destination-card.tsx")
  } else if (/\b(portfolio|portofolio|company profile|agency|profile)\b/i.test(text) || blueprint.appType === "frontend_landing") {
    required.add("sections/services-section.tsx")
    required.add("sections/portfolio-section.tsx")
    required.add("sections/testimonials-section.tsx")
  }

  required.add("sections/hero-section.tsx")
  required.add("sections/features-section.tsx")
  required.add("sections/faq-section.tsx")

  return Array.from(required).slice(0, FULL_FRONTEND_FILE_LIMIT)
}

function detectIntent(prompt: string) {
  return analyzePromptIntent(prompt)
}

function getRequiredFiles(
  intent: IntentAnalysis,
  input: {
    prompt: string
    productionMode: GenerationPlan["productionMode"]
  }
) {
  const blueprint = getControlledAppBlueprint(intent.appType)
  if (input.productionMode === "production_fullstack") {
    return productionRequiredFiles(blueprint, input.prompt)
  }
  if (input.productionMode === "full_frontend") {
    return fullFrontendRequiredFiles(blueprint, input.prompt)
  }

  return blueprint.requiredFiles.slice(0, PREVIEW_FOUNDATION_FILE_LIMIT)
}

function intentStorageKey(intent: IntentAnalysis) {
  return `${intent.appType}:${intent.domain}`
}

function buildFastClinicFullStackScaffold(input: {
  plan: GenerationPlan
  prompt: string
}): GeneratedFile[] | null {
  if (process.env.SWIFT_DISABLE_FAST_FULLSTACK_SCAFFOLD === "true") return null
  if (input.plan.productionMode !== "production_fullstack") return null
  if (input.plan.appType !== "clinic_management") return null
  if (input.plan.editPlan.mode !== "full") return null

  const files = new Map(buildClinicCoreFiles().map((file) => [normalizePath(file.path), file]))
  const plannedPaths = input.plan.filePlan.map((file) => normalizePath(file.path))
  if (plannedPaths.some((path) => !files.has(path))) return null

  return plannedPaths
    .map((path) => files.get(path))
    .filter((file): file is GeneratedFile => Boolean(file))
}

function buildClinicCoreFiles(): GeneratedFile[] {
  return [
    {
      path: "app/layout.tsx",
      language: "tsx",
      content: `import type { ReactNode } from "react"
import "./globals.css"

export const metadata = {
  title: "Swift Clinic BPJS",
  description: "Full-stack clinic management core generated by Swift.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
    },
    {
      path: "app/page.tsx",
      language: "tsx",
      content: `import { ClinicDashboard } from "@/components/clinic-dashboard"

export default function HomePage() {
  return (
    <main className="app-shell">
      <ClinicDashboard />
    </main>
  )
}
`,
    },
    {
      path: "app/globals.css",
      language: "css",
      content: `:root {
  --background: #f6f8fb;
  --foreground: #172033;
  --panel: #ffffff;
  --line: #d8e1ef;
  --muted: #5d6b82;
  --primary: #1268b3;
  --primary-dark: #0d4f88;
  --success: #0f8f6d;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}

button,
input,
select {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  padding: 24px;
}

.clinic-shell {
  display: grid;
  gap: 20px;
  max-width: 1180px;
  margin: 0 auto;
}

.clinic-header,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 12px 30px rgba(23, 32, 51, 0.08);
}

.clinic-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 20px;
}

.clinic-title {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
}

.clinic-subtitle,
.muted {
  color: var(--muted);
}

.status-grid,
.content-grid {
  display: grid;
  gap: 16px;
}

.status-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.content-grid {
  grid-template-columns: 1.1fr 0.9fr;
}

.panel {
  padding: 18px;
}

.metric {
  display: grid;
  gap: 8px;
}

.metric strong {
  font-size: 28px;
}

.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.input {
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: #fff;
}

.button {
  min-height: 40px;
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  color: #fff;
  background: var(--primary);
  cursor: pointer;
}

.button:hover {
  background: var(--primary-dark);
}

.list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  border-radius: 999px;
  padding: 4px 10px;
  color: #07503f;
  background: #dff8ee;
  font-size: 12px;
}

.error {
  color: #9d1c1c;
}

@media (max-width: 800px) {
  .app-shell {
    padding: 12px;
  }

  .clinic-header,
  .row {
    flex-direction: column;
  }

  .status-grid,
  .content-grid {
    grid-template-columns: 1fr;
  }
}
`,
    },
    {
      path: "package.json",
      language: "json",
      content: `${JSON.stringify(
        {
          name: "swift-clinic-bpjs",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            typecheck: "tsc --noEmit",
            lint: "eslint .",
            "db:generate": "prisma generate",
          },
          dependencies: {
            "@prisma/client": "^5.22.0",
            next: "^16.2.6",
            "next-auth": "^5.0.0-beta.20",
            react: "^19.2.5",
            "react-dom": "^19.2.5",
            zod: "^3.24.1",
          },
          devDependencies: {
            "@types/node": "^22",
            "@types/react": "19.2.14",
            "@types/react-dom": "19.2.3",
            eslint: "^9.39.4",
            "eslint-config-next": "^16.2.6",
            prisma: "^5.22.0",
            typescript: "5.7.3",
          },
        },
        null,
        2
      )}\n`,
    },
    {
      path: "prisma/schema.prisma",
      language: "prisma",
      content: `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  PENGELOLA
  DOKTER
  USER
}

enum AppointmentStatus {
  SCHEDULED
  CHECKED_IN
  COMPLETED
  CANCELLED
}

model User {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  role      Role     @default(USER)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Patient {
  id                String              @id @default(cuid())
  medicalRecordNo   String              @unique
  nationalId        String?             @unique
  bpjsNumber        String?
  name              String
  phone             String?
  birthDate         DateTime?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  appointments      Appointment[]
  bpjsVerifications BpjsVerification[]
}

model Doctor {
  id           String        @id @default(cuid())
  name         String
  specialty    String
  licenseNo    String?       @unique
  scheduleNote String?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  appointments Appointment[]
}

model Appointment {
  id        String            @id @default(cuid())
  patientId String
  doctorId  String
  startsAt  DateTime
  status    AppointmentStatus @default(SCHEDULED)
  notes     String?
  createdAt DateTime          @default(now())
  updatedAt DateTime          @updatedAt
  patient   Patient           @relation(fields: [patientId], references: [id], onDelete: Cascade)
  doctor    Doctor            @relation(fields: [doctorId], references: [id], onDelete: Cascade)
}

model BpjsVerification {
  id        String   @id @default(cuid())
  patientId String?
  nik       String?
  bpjsNo    String?
  status    String
  response  Json?
  checkedAt DateTime @default(now())
  patient   Patient? @relation(fields: [patientId], references: [id], onDelete: SetNull)
}
`,
    },
    {
      path: "lib/services/clinic.service.ts",
      language: "ts",
      content: `import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { swiftClinicPrisma?: PrismaClient }

export const prisma =
  globalForPrisma.swiftClinicPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.swiftClinicPrisma = prisma
}

type PatientInput = {
  name: string
  medicalRecordNo?: string
  nationalId?: string
  bpjsNumber?: string
  phone?: string
}

type DoctorInput = {
  name: string
  specialty: string
  licenseNo?: string
  scheduleNote?: string
}

type AppointmentInput = {
  patientId: string
  doctorId: string
  startsAt: string
  notes?: string
}

function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL)
}

export async function listPatients() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.patient.findMany({ orderBy: { createdAt: "desc" }, take: 50 })
  } catch {
    return []
  }
}

export async function createPatient(input: PatientInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.patient.create({
    data: {
      name: input.name,
      medicalRecordNo: input.medicalRecordNo || \`MR-\${Date.now()}\`,
      nationalId: input.nationalId || null,
      bpjsNumber: input.bpjsNumber || null,
      phone: input.phone || null,
    },
  })
}

export async function listDoctors() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.doctor.findMany({ orderBy: { name: "asc" }, take: 50 })
  } catch {
    return []
  }
}

export async function createDoctor(input: DoctorInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.doctor.create({
    data: {
      name: input.name,
      specialty: input.specialty,
      licenseNo: input.licenseNo || null,
      scheduleNote: input.scheduleNote || null,
    },
  })
}

export async function listAppointments() {
  if (!databaseConfigured()) return []
  try {
    return await prisma.appointment.findMany({
      include: { patient: true, doctor: true },
      orderBy: { startsAt: "asc" },
      take: 50,
    })
  } catch {
    return []
  }
}

export async function createAppointment(input: AppointmentInput) {
  if (!databaseConfigured()) {
    return { status: "database_required", input }
  }
  return prisma.appointment.create({
    data: {
      patientId: input.patientId,
      doctorId: input.doctorId,
      startsAt: new Date(input.startsAt),
      notes: input.notes || null,
    },
  })
}
`,
    },
    {
      path: "lib/services/bpjs.service.ts",
      language: "ts",
      content: `type BpjsLookupInput = {
  nik?: string | null
  bpjsNumber?: string | null
}

function bpjsConfigured() {
  return Boolean(process.env.BPJS_API_BASE_URL && process.env.BPJS_CONS_ID && process.env.BPJS_SECRET_KEY)
}

export async function verifyBpjsParticipant(input: BpjsLookupInput) {
  const identifier = input.bpjsNumber || input.nik || ""
  if (!identifier) {
    return { ok: false, status: "missing_identifier" }
  }

  if (!bpjsConfigured()) {
    return {
      ok: false,
      status: "configuration_required",
      identifier,
      requiredEnv: ["BPJS_API_BASE_URL", "BPJS_CONS_ID", "BPJS_SECRET_KEY", "BPJS_USER_KEY"],
    }
  }

  const baseUrl = String(process.env.BPJS_API_BASE_URL).replace(/\\/+$/, "")
  const response = await fetch(\`\${baseUrl}/peserta/\${encodeURIComponent(identifier)}\`, {
    headers: {
      "x-cons-id": process.env.BPJS_CONS_ID || "",
      "user_key": process.env.BPJS_USER_KEY || "",
    },
    cache: "no-store",
  })

  const payload = await response.json().catch(() => null)
  return {
    ok: response.ok,
    status: response.ok ? "verified" : "bpjs_error",
    identifier,
    payload,
  }
}
`,
    },
    {
      path: "app/api/patients/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createPatient, listPatients } from "@/lib/services/clinic.service"

const patientSchema = z.object({
  name: z.string().min(2),
  medicalRecordNo: z.string().optional(),
  nationalId: z.string().optional(),
  bpjsNumber: z.string().optional(),
  phone: z.string().optional(),
})

export async function GET() {
  const patients = await listPatients()
  return NextResponse.json({ patients })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = patientSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patient payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const patient = await createPatient(parsed.data)
  return NextResponse.json({ patient }, { status: 201 })
}
`,
    },
    {
      path: "app/api/doctors/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createDoctor, listDoctors } from "@/lib/services/clinic.service"

const doctorSchema = z.object({
  name: z.string().min(2),
  specialty: z.string().min(2),
  licenseNo: z.string().optional(),
  scheduleNote: z.string().optional(),
})

export async function GET() {
  const doctors = await listDoctors()
  return NextResponse.json({ doctors })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = doctorSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid doctor payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const doctor = await createDoctor(parsed.data)
  return NextResponse.json({ doctor }, { status: 201 })
}
`,
    },
    {
      path: "app/api/appointments/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createAppointment, listAppointments } from "@/lib/services/clinic.service"

const appointmentSchema = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  startsAt: z.string().min(1),
  notes: z.string().optional(),
})

export async function GET() {
  const appointments = await listAppointments()
  return NextResponse.json({ appointments })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = appointmentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid appointment payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const appointment = await createAppointment(parsed.data)
  return NextResponse.json({ appointment }, { status: 201 })
}
`,
    },
    {
      path: "app/api/auth/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

const loginSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "PENGELOLA", "DOKTER", "USER"]).default("USER"),
})

export async function GET() {
  return NextResponse.json({
    roles: ["ADMIN", "PENGELOLA", "DOKTER", "USER"],
    strategy: "NextAuth-ready route boundary",
  })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid auth payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  return NextResponse.json({
    user: {
      email: parsed.data.email,
      role: parsed.data.role,
    },
  })
}
`,
    },
    {
      path: "app/api/bpjs/route.ts",
      language: "ts",
      content: `import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { verifyBpjsParticipant } from "@/lib/services/bpjs.service"

const bpjsSchema = z.object({
  nik: z.string().optional(),
  bpjsNumber: z.string().optional(),
})

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams
  const result = await verifyBpjsParticipant({
    nik: search.get("nik"),
    bpjsNumber: search.get("bpjsNumber"),
  })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const parsed = bpjsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid BPJS payload", issues: parsed.error.flatten() }, { status: 400 })
  }
  const result = await verifyBpjsParticipant(parsed.data)
  return NextResponse.json(result)
}
`,
    },
    {
      path: "components/clinic-dashboard.tsx",
      language: "tsx",
      content: `"use client"

import { useEffect, useMemo, useState } from "react"

type ApiState<T> = {
  data: T
  loading: boolean
  error: string | null
}

type Patient = {
  id: string
  name: string
  medicalRecordNo?: string
  bpjsNumber?: string | null
}

type Doctor = {
  id: string
  name: string
  specialty: string
}

type Appointment = {
  id: string
  startsAt: string
  status: string
  patient?: Patient
  doctor?: Doctor
}

async function loadJson<T>(url: string, key: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) {
    throw new Error(\`\${url} returned \${response.status}\`)
  }
  const payload = await response.json()
  return (payload[key] || []) as T
}

export function ClinicDashboard() {
  const [patients, setPatients] = useState<ApiState<Patient[]>>({ data: [], loading: true, error: null })
  const [doctors, setDoctors] = useState<ApiState<Doctor[]>>({ data: [], loading: true, error: null })
  const [appointments, setAppointments] = useState<ApiState<Appointment[]>>({ data: [], loading: true, error: null })
  const [nik, setNik] = useState("")
  const [bpjsStatus, setBpjsStatus] = useState<string>("Belum dicek")

  useEffect(() => {
    let active = true
    Promise.all([
      loadJson<Patient[]>("/api/patients", "patients"),
      loadJson<Doctor[]>("/api/doctors", "doctors"),
      loadJson<Appointment[]>("/api/appointments", "appointments"),
    ])
      .then(([patientRows, doctorRows, appointmentRows]) => {
        if (!active) return
        setPatients({ data: patientRows, loading: false, error: null })
        setDoctors({ data: doctorRows, loading: false, error: null })
        setAppointments({ data: appointmentRows, loading: false, error: null })
      })
      .catch((error: Error) => {
        if (!active) return
        const message = error.message || "Gagal memuat data klinik"
        setPatients({ data: [], loading: false, error: message })
        setDoctors({ data: [], loading: false, error: message })
        setAppointments({ data: [], loading: false, error: message })
      })
    return () => {
      active = false
    }
  }, [])

  const metrics = useMemo(
    () => [
      { label: "Pasien", value: patients.data.length },
      { label: "Dokter", value: doctors.data.length },
      { label: "Jadwal", value: appointments.data.length },
      { label: "Role", value: 4 },
    ],
    [appointments.data.length, doctors.data.length, patients.data.length]
  )

  async function checkBpjs() {
    setBpjsStatus("Memeriksa BPJS")
    const response = await fetch(\`/api/bpjs?nik=\${encodeURIComponent(nik)}\`, { cache: "no-store" })
    const payload = await response.json().catch(() => null)
    setBpjsStatus(payload?.status || "Tidak ada respons")
  }

  return (
    <section className="clinic-shell">
      <header className="clinic-header">
        <div>
          <p className="muted">Swift full-stack core</p>
          <h1 className="clinic-title">Manajemen Klinik dan BPJS</h1>
          <p className="clinic-subtitle">
            Dashboard terpadu untuk pasien, dokter, janji temu, role pengguna, dan batas integrasi BPJS.
          </p>
        </div>
        <span className="badge">Runnable preview</span>
      </header>

      <div className="status-grid">
        {metrics.map((metric) => (
          <article className="panel metric" key={metric.label}>
            <span className="muted">{metric.label}</span>
            <strong>{metric.value}</strong>
          </article>
        ))}
      </div>

      <div className="content-grid">
        <article className="panel">
          <h2>Operasional Hari Ini</h2>
          {patients.error ? <p className="error">{patients.error}</p> : null}
          <div className="list">
            {appointments.loading ? <p className="muted">Memuat jadwal...</p> : null}
            {!appointments.loading && appointments.data.length === 0 ? (
              <p className="muted">Belum ada jadwal. API dan Prisma model sudah siap menerima data.</p>
            ) : null}
            {appointments.data.map((item) => (
              <div className="row" key={item.id}>
                <div>
                  <strong>{item.patient?.name || "Pasien"}</strong>
                  <p className="muted">{item.doctor?.name || "Dokter belum dipilih"}</p>
                </div>
                <span className="badge">{item.status}</span>
              </div>
            ))}
          </div>
        </article>

        <aside className="panel">
          <h2>Cek BPJS</h2>
          <p className="muted">Gunakan NIK atau nomor BPJS untuk memanggil route integrasi server-side.</p>
          <div className="toolbar">
            <input
              className="input"
              value={nik}
              onChange={(event) => setNik(event.target.value)}
              placeholder="NIK atau nomor BPJS"
            />
            <button className="button" type="button" onClick={checkBpjs}>
              Cek
            </button>
          </div>
          <p className="muted">Status: {bpjsStatus}</p>
        </aside>
      </div>
    </section>
  )
}
`,
    },
  ]
}

function buildGenerationPlan(input: {
  prompt: string
  existingFiles: GeneratedFile[]
  collaborationMode?: CollaborationMode | null
  previewContext?: unknown
  previousMemoryJson?: string | null
}) {
  const previewContext = normalizePreviewContext(input.previewContext)
  const classification = classifyPrompt(input.prompt, {
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode || undefined,
    previewError: previewContext?.previewError?.message || null,
  })
  const intent = detectIntent(input.prompt)
  const structuredIntent = parseStructuredIntent({
    prompt: input.prompt,
    appType: intent.appType,
  })
  const editPlan = buildPartialEditPlan({
    prompt: input.prompt,
    existingFiles: input.existingFiles,
    collaborationMode: input.collaborationMode,
    previewContext,
  })
  const incrementalEdit = buildIncrementalEditPlan({
    prompt: input.prompt,
    files: input.existingFiles,
    collaborationMode: input.collaborationMode,
    activeFilePath: previewContext?.activeFilePath || null,
    previewErrorFile: previewContext?.previewError?.filename || null,
  })
  const appType = structuredIntent.type === "frontend_only" && isHardFrontendOnlyPrompt(input.prompt)
    ? "frontend_landing"
    : intent.appType || classifyControlledAppType(input.prompt)
  const blueprint = getControlledAppBlueprint(appType)
  const generationMode = incrementalEdit.generationMode
  const productionMode =
    generationMode === "FULLSTACK" ||
    (generationMode !== "PATCH" && generationMode !== "PREVIEW" && (shouldUseProductionFullStackMode(input.prompt, {
      collaborationMode: input.collaborationMode,
    }) || structuredIntent.type === "fullstack_app"))
      ? "production_fullstack"
      : generationMode === "PREVIEW"
        ? "preview"
        : "full_frontend"
  const architecture = buildArchitecturePlan({
    intent: structuredIntent,
    existingFiles: input.existingFiles,
  })
  const projectMemory = buildProjectMemoryGraph({
    files: input.existingFiles,
    intent: structuredIntent,
    architecturePlan: architecture,
    previousMemoryJson: input.previousMemoryJson,
  })
  const dependencyGraph = buildArchitectureDependencyGraph({
    intent: structuredIntent,
    architecturePlan: architecture,
    memory: projectMemory,
  })
  const requiredFilesForIntent = getRequiredFiles(intent, {
    prompt: input.prompt,
    productionMode,
  })
  const orchestration = createSoftwareOrchestration({
    prompt: input.prompt,
    appType,
    structuredIntent,
    architecture,
    projectMemory,
    dependencyGraph,
    blueprintRequiredFiles: requiredFilesForIntent,
  })
  assertSoftwareOrchestrationReady(orchestration)
  const stagedEcommerceRequested = orchestration.plannerOutput.appType === "ecommerce" && editPlan.mode === "full"
  const maxFilesThisPass =
    productionMode === "production_fullstack"
      ? stagedEcommerceRequested
        ? Math.max(PRODUCTION_FULLSTACK_FILE_LIMIT, 24)
        : PRODUCTION_FULLSTACK_FILE_LIMIT
      : productionMode === "full_frontend"
        ? FULL_FRONTEND_FILE_LIMIT
        : editPlan.maxSlices
  const trimmed = trimContextForGeneration({
    prompt: input.prompt,
    files: input.existingFiles,
    activeFilePath: previewContext?.activeFilePath || undefined,
    previewErrorFile: previewContext?.previewError?.filename || undefined,
    layer: classification === "simple_ui" ? "fast" : "builder",
  })

  const plannedByPath = new Map<string, GenerationPlannerFile>()
  const explicitlyRequestedPaths = extractRequestedFilePaths(input.prompt).map(normalizePath)
  const singleFileOnly = explicitlyRequestedPaths.length === 1 && /\b(only|saja|hanya)\b/i.test(input.prompt)
  const frontendOnly = structuredIntent.type === "frontend_only"

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
    const architecturePaths = frontendOnly && singleFileOnly
      ? explicitlyRequestedPaths
      : [
      ...architecture.frontend.pages,
      ...architecture.backend.apiRoutes,
      ...architecture.backend.services,
      architecture.database.schema,
      ...architecture.storage.adapters,
      ...architecture.payments.routes,
      ...architecture.payments.services,
      ".env.example",
    ]
    for (const filePath of architecturePaths.filter((filePath) => filePath && filePath !== "none").slice(0, maxFilesThisPass)) {
      if (plannedByPath.size >= maxFilesThisPass) break
      const path = normalizePath(filePath)
      plannedByPath.set(path, {
        path,
        reason: `Structured architecture plan requires ${path}`,
        action: "create_or_update",
      })
    }

    for (const filePath of explicitlyRequestedPaths.slice(0, maxFilesThisPass)) {
      plannedByPath.set(normalizePath(filePath), {
        path: normalizePath(filePath),
        reason:
          productionMode === "production_fullstack"
            ? "Explicitly requested by the prompt for the production full-stack plan"
            : productionMode === "full_frontend"
              ? "Explicitly requested by the prompt for the full frontend architecture"
              : "Explicitly requested by the prompt for the preview foundation",
        action: "create_or_update",
      })
    }

    for (const filePath of (singleFileOnly ? [] : requiredFilesForIntent)) {
      if (plannedByPath.size >= maxFilesThisPass) break
      plannedByPath.set(normalizePath(filePath), {
        path: normalizePath(filePath),
        reason:
          productionMode === "production_fullstack"
            ? `${blueprint.label} production full-stack plan requires this file`
            : `${blueprint.label} blueprint requires this file for deployable generation`,
        action: "create_or_update",
      })
    }

    for (const file of trimmed.files.slice(0, 8)) {
      if (plannedByPath.size >= maxFilesThisPass) break
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

  const filePlan = Array.from(plannedByPath.values()).slice(0, maxFilesThisPass)

  for (const componentPath of singleFileOnly ? [] : orchestration.plannerOutput.requiredComponents) {
    const path = normalizePath(componentPath)
    if (isImplicitHelperFile(path, explicitlyRequestedPaths)) {
      continue
    }
    if (!plannedByPath.has(path) && filePlan.length < maxFilesThisPass) {
      filePlan.push({
        path,
        reason: `Staged component graph requires ${path}`,
        action: "create_or_update",
      })
    }
  }
  if (stagedEcommerceRequested) {
    for (const stagedPath of [
      "lib/supabase/client.ts",
      "lib/supabase/server.ts",
      "lib/turso/client.ts",
      "app/api/transactions/route.ts",
    ]) {
      const path = normalizePath(stagedPath)
      if (!filePlan.some((item) => normalizePath(item.path) === path) && filePlan.length < maxFilesThisPass) {
        filePlan.push({
          path,
          reason: stagedPath.includes("supabase")
            ? "Tahap 4 requires Supabase auth/database boundary"
            : "Tahap 5 requires Turso lightweight transaction boundary",
          action: "create_or_update",
        })
      }
    }
  }

  if (!filePlan.some((item) => /^app\/page\.(tsx|ts|jsx|js)$/i.test(item.path))) {
    const shouldAddHomePage = editPlan.mode === "full" || input.existingFiles.length === 0
    if (shouldAddHomePage) {
      filePlan.unshift({
        path: "app/page.tsx",
        reason: "Primary visible entrypoint should be generated or refined first",
        action: "create_or_update",
      })
      if (filePlan.length > maxFilesThisPass) {
        filePlan.pop()
      }
    }
  }
  if (editPlan.mode === "full" && !singleFileOnly && (!frontendOnly || productionMode === "full_frontend")) {
    const existingOrPlannedPaths = new Set([
      ...input.existingFiles.map((file) => normalizePath(file.path)),
      ...filePlan.map((file) => normalizePath(file.path)),
    ])
    const scaffoldTargets: GenerationPlannerFile[] = [
      { path: "app/layout.tsx", reason: "Required baseline scaffold layout", action: "create_or_update" },
      { path: "app/page.tsx", reason: "Required baseline scaffold home route", action: "create_or_update" },
      { path: "app/globals.css", reason: "Required baseline global stylesheet", action: "create_or_update" },
      { path: "package.json", reason: "Required baseline package manifest", action: "create_or_update" },
      { path: "tsconfig.json", reason: "Required baseline TypeScript config", action: "create_or_update" },
      { path: "tailwind.config.ts", reason: "Required baseline Tailwind config", action: "create_or_update" },
    ]
    for (const scaffoldTarget of scaffoldTargets.reverse()) {
      if (!existingOrPlannedPaths.has(scaffoldTarget.path)) {
        filePlan.unshift(scaffoldTarget)
        existingOrPlannedPaths.add(scaffoldTarget.path)
      }
    }
    while (filePlan.length > maxFilesThisPass) {
      const removed = filePlan.pop()
      if (removed && /^app\/(layout|page)\.tsx$|^app\/globals\.css$|^(package|tsconfig)\.json$|^tailwind\.config\.ts$/i.test(removed.path)) {
        filePlan.unshift(removed)
        filePlan.pop()
      }
    }
  }
  for (let index = filePlan.length - 1; index >= 0; index -= 1) {
    const safePath = safeGeneratedPath(filePlan[index].path)
    if (!safePath) {
      filePlan.splice(index, 1)
      continue
    }
    filePlan[index].path = safePath
  }
  for (const item of filePlan) {
    item.stage = stagedPhaseForPath(item.path, orchestration.plannerOutput.appType)
  }
  filePlan.sort((left, right) => {
    const phaseOrder: Record<StagedGenerationPhase, number> = {
      scaffold: 0,
      routes: 1,
      components: 2,
      supabase: 3,
      turso: 4,
      support: 5,
    }
    if (productionMode === "full_frontend") {
      const leftGenerationOrder = generationDependencyOrder(left.path, productionMode)
      const rightGenerationOrder = generationDependencyOrder(right.path, productionMode)
      if (leftGenerationOrder !== rightGenerationOrder) return leftGenerationOrder - rightGenerationOrder
    }
    const leftOrder = phaseOrder[left.stage || "support"]
    const rightOrder = phaseOrder[right.stage || "support"]
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    const leftGenerationOrder = generationDependencyOrder(left.path, productionMode)
    const rightGenerationOrder = generationDependencyOrder(right.path, productionMode)
    if (leftGenerationOrder !== rightGenerationOrder) return leftGenerationOrder - rightGenerationOrder
    return left.path.localeCompare(right.path)
  })
  if (stagedEcommerceRequested) {
    const allowed = new Set(orchestration.allowedScope.map(normalizePath))
    const scopedPlan = filePlan.filter((item) => allowed.has(normalizePath(item.path)))
    filePlan.splice(0, filePlan.length, ...scopedPlan)
  }
  const allowedFileScope = buildAllowedFileScopeContract({
    filePlan,
    existingFiles: input.existingFiles,
    editPlan,
  })
  orchestration.allowedScope = allowedFileScope.allowedPaths
  const agentTasks = buildAgentTaskPlan(input.prompt, filePlan, {
    productionMode,
    editMode: editPlan.mode,
  })
  const existingPathSet = new Set(input.existingFiles.map((file) => normalizePath(file.path)))
  const actionPlan = filePlan.map((file): AgentWorkflowAction => {
    const path = normalizePath(file.path)
    return {
      action: existingPathSet.has(path) ? "modify" : "create",
      file: path,
      reason: file.reason,
    }
  })

  return {
    objective: classification,
    generationMode,
    appType,
    intent,
    structuredIntent,
    incrementalEdit,
    editPlan,
    productionMode,
    maxFilesThisPass,
    blueprint: {
      label: blueprint.label,
      requiredFiles: requiredFilesForIntent,
      stack: blueprint.dependencyPolicy.stack,
    },
    filePlan,
    allowedFileScope,
    architecturePlan: blueprint.architectureRules,
    architecture,
    projectMemory,
    dependencyGraph,
    orchestration,
    dependencyPlan: [
      "Use only the locked Swift stack.",
      `Allowed packages: ${blueprint.dependencyPolicy.allowedExternalPackages.join(", ")}`,
      "Do not introduce alternate frameworks, databases, routers, or package managers.",
      `Required env vars: ${architecture.requiredEnvVars.join(", ") || "none"}`,
    ],
    fileGraphPlan: filePlan.map((file) => `${file.path}: ${file.reason}`),
    agentTasks,
    actionPlan,
    contextBudget: {
      ...trimmed.budget,
      usedFiles: trimmed.files.length,
      usedChars: trimmed.totalChars,
    },
  } satisfies GenerationPlan
}

function buildAgentTaskPlan(
  prompt: string,
  filePlan: GenerationPlannerFile[],
  input: {
    productionMode: GenerationPlan["productionMode"]
    editMode: PartialEditPlan["mode"]
  }
) {
  const text = prompt.toLowerCase()
  const tasks: string[] = []
  const addTask = (task: string) => {
    if (!tasks.includes(task)) tasks.push(task)
  }

  addTask(input.editMode === "partial" ? "scope edit" : "setup project")

  if (filePlan.some((file) => normalizePath(file.path) === "prisma/schema.prisma") || /\b(prisma|database|db|postgres|schema)\b/i.test(text)) {
    addTask("setup prisma")
  }

  if (/\b(auth|login|register|role|rbac|admin|user|session)\b/i.test(text)) {
    addTask("setup auth")
    addTask("create role system")
  }

  if (filePlan.some((file) => normalizePath(file.path).startsWith("app/api/")) || /\b(api|route|crud|webhook|integration|integrasi)\b/i.test(text)) {
    addTask("create APIs")
  }

  if (/\b(upload|file|asset|storage|lampiran|gambar)\b/i.test(text)) {
    addTask("create uploads")
  }

  if (filePlan.some((file) => /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(normalizePath(file.path))) || /\b(dashboard|admin|panel|page|halaman|ui)\b/i.test(text)) {
    addTask("create dashboard")
  }

  if (input.productionMode === "production_fullstack") {
    addTask("generate backend blueprint")
    addTask("wire full-stack boundaries")
  }

  addTask("verify project")
  return tasks.slice(0, 12)
}

function buildAllowedFileScopeContract(input: {
  filePlan: GenerationPlannerFile[]
  existingFiles: GeneratedFile[]
  editPlan: PartialEditPlan
}): AllowedFileScopeContract {
  const targetPaths = uniquePaths(input.filePlan.map((file) => file.path))
  const existingPaths = uniquePaths(input.existingFiles.map((file) => file.path))
  const allowedPaths =
    input.editPlan.mode === "partial"
      ? uniquePaths([
          ...input.editPlan.targetPaths,
          ...input.editPlan.allowedNewPaths,
          ...targetPaths,
        ])
      : targetPaths

  return {
    kind: "swift_allowed_file_scope",
    allowedPaths,
    targetPaths,
    existingPaths,
    helperPolicy: "explicit_only",
    blockedHelperPatterns: ["components/app-shell.tsx", "components/*-shell.tsx", "components/*helper*.tsx"],
    reason: "Scope is frozen from the approved generation file plan before Builder AI runs.",
  }
}

function isImplicitHelperFile(path: string, explicitlyRequestedPaths: string[]) {
  const normalized = normalizePath(path).toLowerCase()
  if (explicitlyRequestedPaths.map((item) => item.toLowerCase()).includes(normalized)) return false
  return (
    normalized === "components/app-shell.tsx" ||
    /^components\/[^/]*-shell\.(tsx|ts|jsx|js)$/i.test(normalized) ||
    /^components\/[^/]*helper[^/]*\.(tsx|ts|jsx|js)$/i.test(normalized)
  )
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean))).sort()
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).slice(0, 80)
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
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

async function updateDeveloperDiagnostics(jobId: string, diagnostics: ReturnType<typeof createDeveloperGenerationDiagnostics>) {
  await GenerationJobService.update(jobId, {
    diagnostics: {
      developer: diagnostics,
    },
  }).catch(() => null)
}

async function appendOrchestrationEvent(input: {
  jobId: string
  trace?: TraceIds
  type: string
  stage: GenerationJobStage
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  message: string
  data?: Record<string, unknown> | null
}) {
  log(input.status === "failed" ? "error" : input.status === "cancelled" ? "warn" : "info", input.type, {
    event: input.type,
    jobId: input.jobId,
    stage: input.stage,
    status: input.status,
    message: input.message,
    ...(input.data || {}),
  })
  await OrchestrationRuntimeService.appendEvent(input)
  if (input.status === "failed") {
    await OrchestrationRuntimeService.persistFailure({
      jobId: input.jobId,
      trace: input.trace,
      eventType: input.type,
      stage: input.stage,
      reason: input.message,
      retryCount: typeof input.data?.repairAttempts === "number" ? input.data.repairAttempts : 0,
      terminationReason: typeof input.data?.reason === "string" ? input.data.reason : null,
      metadata: input.data,
    }).catch(() => null)
  }
}

async function captureValidationRuntimeFailure(input: {
  jobId: string
  projectId: string
  trace?: TraceIds
  files: GeneratedFile[]
  message: string
  source: "sandbox" | "orchestrator"
  metadata?: Record<string, unknown>
}) {
  const runtimeDiagnostics = extractRuntimeFailureDiagnostics(input.message, input.metadata)
  const runtimeCategory = categorizeRuntimeFailure(runtimeDiagnostics, input.message, input.metadata)
  const renderingCategory = runtimeCategory === "rendering_failed"
    ? categorizeRenderingFailure(runtimeDiagnostics, input.message, input.metadata)
    : null
  const reportDir = await persistRuntimeFailureReport({
    jobId: input.jobId,
    projectId: input.projectId,
    category: runtimeCategory,
    message: input.message,
    diagnostics: runtimeDiagnostics,
    logs: runtimeDiagnostics.logs,
    files: input.files,
  }).catch((error) => {
    log("warn", "runtime_failure_report_write_failed", {
      jobId: input.jobId,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  const renderReportDir = renderingCategory
    ? await persistRenderFailureReport({
        jobId: input.jobId,
        projectId: input.projectId,
        category: renderingCategory,
        message: input.message,
        diagnostics: runtimeDiagnostics,
        files: input.files,
      }).catch((error) => {
        log("warn", "render_failure_report_write_failed", {
          jobId: input.jobId,
          projectId: input.projectId,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      })
    : null
  const capture = await captureRuntimeError({
    projectId: input.projectId,
    jobId: input.jobId,
    trace: input.trace,
    message: input.message,
    source: input.source,
    severity: "error",
    metadata: {
      ...(input.metadata || {}),
      runtimeCategory,
      renderingCategory,
      runtimeDiagnostics,
      reportDir,
      renderReportDir,
    },
  }).catch(() => null)

  if (!capture) return null

  const diagnosis = diagnoseRuntimeError({
    error: input.message,
    files: input.files,
  })
  await recordRuntimeRecoveryEvent({
    capture,
    phase: "diagnose",
    diagnosis,
    jobId: input.jobId,
    trace: input.trace,
    stage: "building",
    status: diagnosis.route === "targeted_repair" ? "running" : "failed",
    message: diagnosis.route === "targeted_repair"
      ? "Runtime failure isolated for targeted repair"
      : "Runtime failure captured but automatic repair requires manual review",
    metadata: {
      ...input.metadata,
      runtimeCategory,
      renderingCategory,
      runtimeDiagnostics,
      reportDir,
      renderReportDir,
      fullRegenerationAllowed: false,
      preserveSuccessfulState: true,
    },
  }).catch(() => null)
  return { capture, diagnosis }
}

function extractRuntimeFailureDiagnostics(message: string, metadata?: Record<string, unknown>) {
  const runtimeVerification = metadata?.runtimeVerification as {
    diagnostics?: Record<string, unknown>
    checks?: Array<{ message?: string; category?: string; data?: unknown }>
    failureCategory?: string
    error?: string
  } | null | undefined
  const logs = Array.isArray(metadata?.logs) ? metadata.logs.map(String) : []
  const diagnostics = runtimeVerification?.diagnostics || {}
  const allText = [
    message,
    runtimeVerification?.error,
    runtimeVerification?.failureCategory,
    ...logs,
    ...Object.values(diagnostics).flatMap((value) => Array.isArray(value) ? value.map(String) : [String(value || "")]),
  ].filter(Boolean).join("\n")

  const pick = (pattern: RegExp) =>
    allText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => pattern.test(line))
      .slice(0, 40)

  return {
    browserConsoleErrors: asStringArray(diagnostics.browserConsoleErrors),
    hydrationErrors: asStringArray(diagnostics.hydrationErrors),
    runtimeStackTraces: asStringArray(diagnostics.runtimeStackTraces),
    missingDependencies: uniqueStrings([
      ...asStringArray(diagnostics.missingDependencies),
      ...pick(/module not found|cannot find module|can't resolve|failed to resolve|missing dependency/i),
    ]),
    routeErrors: uniqueStrings([
      ...asStringArray(diagnostics.routeErrors),
      ...pick(/route|page|api route|returned 5\d\d|failed to render/i),
    ]),
    environmentVariableErrors: uniqueStrings([
      ...asStringArray(diagnostics.environmentVariableErrors),
      ...pick(/env|environment variable|process\.env|DATABASE_URL|NEXTAUTH|SUPABASE|OPENROUTER/i),
    ]),
    importErrors: uniqueStrings([
      ...asStringArray(diagnostics.importErrors),
      ...pick(/import|export|does not provide an export|Cannot access .* before initialization/i),
    ]),
    reactErrorBoundaryOutput: uniqueStrings(asStringArray(diagnostics.reactErrorBoundaryOutput)),
    componentTree: uniqueStrings(asStringArray(diagnostics.componentTree)),
    propsTree: uniqueStrings([
      ...asStringArray(diagnostics.propsTree),
      ...pick(/props|property|undefined|null|cannot read properties|is not a function/i),
    ]),
    serverClientComponentMismatches: uniqueStrings([
      ...asStringArray(diagnostics.serverClientComponentMismatches),
      ...pick(/server component|client component|use client|event handlers cannot be passed|createContext only works in client/i),
    ]),
    providerContextTree: uniqueStrings([
      ...asStringArray(diagnostics.providerContextTree),
      ...pick(/provider|context|useContext|must be used within|missing provider/i),
    ]),
    asyncRenderingErrors: uniqueStrings([
      ...asStringArray(diagnostics.asyncRenderingErrors),
      ...pick(/async|promise|suspense|await|thenable|uncached promise/i),
    ]),
    layoutHierarchy: uniqueStrings([
      ...asStringArray(diagnostics.layoutHierarchy),
      ...pick(/layout|root layout|html|body|metadata/i),
    ]),
    pageRenderStackTraces: uniqueStrings(asStringArray(diagnostics.pageRenderStackTraces)),
    logs,
  }
}

function categorizeRuntimeFailure(
  diagnostics: ReturnType<typeof extractRuntimeFailureDiagnostics>,
  message: string,
  metadata?: Record<string, unknown>
): RuntimeFailureCategory {
  const runtimeVerification = metadata?.runtimeVerification as { failureCategory?: string } | null | undefined
  const raw = [
    message,
    runtimeVerification?.failureCategory,
    diagnostics.logs.join("\n"),
    diagnostics.browserConsoleErrors.join("\n"),
    diagnostics.runtimeStackTraces.join("\n"),
  ].join("\n").toLowerCase()

  if (diagnostics.hydrationErrors.length > 0 || /hydration/.test(raw)) return "hydration_failed"
  if (diagnostics.missingDependencies.length > 0 || /module not found|cannot find module|can't resolve|missing dependency/.test(raw)) return "dependency_failed"
  if (diagnostics.environmentVariableErrors.length > 0 || /environment variable|process\.env|database_url|nextauth|supabase|openrouter/.test(raw)) return "environment_failed"
  if (diagnostics.importErrors.length > 0 || /import|export|does not provide an export/.test(raw)) return "import_failed"
  if (diagnostics.routeErrors.length > 0 || /api_route|route_render|homepage_render|failed to render|returned 5\d\d/.test(raw)) return "route_failed"
  if (/sandbox|server_unreachable|timeout|preview server exited/.test(raw)) return "sandbox_failed"
  return "rendering_failed"
}

function categorizeRenderingFailure(
  diagnostics: ReturnType<typeof extractRuntimeFailureDiagnostics>,
  message: string,
  metadata?: Record<string, unknown>
): RenderingFailureCategory {
  const raw = [
    message,
    diagnostics.logs.join("\n"),
    diagnostics.browserConsoleErrors.join("\n"),
    diagnostics.runtimeStackTraces.join("\n"),
    diagnostics.reactErrorBoundaryOutput.join("\n"),
    diagnostics.serverClientComponentMismatches.join("\n"),
    diagnostics.providerContextTree.join("\n"),
    diagnostics.propsTree.join("\n"),
    diagnostics.asyncRenderingErrors.join("\n"),
    diagnostics.layoutHierarchy.join("\n"),
    JSON.stringify(metadata || {}),
  ].join("\n").toLowerCase()

  if (diagnostics.serverClientComponentMismatches.length > 0 || /server component|client component|use client|event handlers cannot be passed|createcontext only works/.test(raw)) {
    return "client_server_boundary_failed"
  }
  if (diagnostics.providerContextTree.length > 0 || /missing provider|must be used within|usecontext|provider/.test(raw)) {
    return "provider_missing"
  }
  if (diagnostics.asyncRenderingErrors.length > 0 || /async|promise|suspense|uncached promise|thenable/.test(raw)) {
    return "async_render_failed"
  }
  if (diagnostics.layoutHierarchy.length > 0 && /root layout|layout|html|body|metadata/.test(raw)) {
    return "layout_failed"
  }
  if (diagnostics.propsTree.length > 0 || /props|property|undefined|null|cannot read properties|is not a function/.test(raw)) {
    return "props_mismatch"
  }
  if (/usestate|initial state|initializer|reducer|setstate|state/.test(raw)) {
    return "state_initialization_failed"
  }
  return "component_tree_failed"
}

function classifyRepairTerminationReason(input: {
  reason?: string | null
  error?: unknown
  repairAttempt: number
  maxRepairAttempts: number
  validation?: ValidationLifecycleResult | null
}): RepairTerminationReason | null {
  const raw = `${input.reason || ""} ${input.error instanceof Error ? input.error.message : input.error ? String(input.error) : ""}`.toLowerCase()
  if (/abort|timeout|timed out/.test(raw)) return "timeout"
  if (/parse|json|malformed|schema|strict/i.test(raw)) return "malformed_repair_payload"
  if (/accepted_file_changes_zero|no accepted|empty|produced no accepted/.test(raw)) return "empty_repair_output"
  if (/patch_changed_no_files|identical|unchanged|same artifact|repeated/.test(raw)) return "repeated_identical_artifact"
  if (/identical_error_repeated|build_output_unchanged|deadlock/.test(raw)) return "validator_deadlock"
  if (/repair_score_regressed|score regressed/.test(raw)) return "repair_score_regressed"
  if (!input.validation?.ok && input.repairAttempt >= input.maxRepairAttempts) return "max_retries_exceeded"
  return null
}

function publicRepairTerminationReason(reason: RepairTerminationReason | string | null) {
  if (!reason) return "Unknown orchestration failure"
  const labels: Record<RepairTerminationReason, string> = {
    max_retries_exceeded: "Max repair retries exceeded",
    repeated_identical_artifact: "Repeated identical artifact",
    validator_deadlock: "Validator deadlock",
    empty_repair_output: "Empty repair output",
    timeout: "Repair timeout",
    malformed_repair_payload: "Malformed repair payload",
    repair_score_regressed: "Repair score regressed",
  }
  return labels[reason as RepairTerminationReason] || reason
}

const totalFileBytes = (files: GeneratedFile[]) =>
  files.reduce((sum, file) => sum + Buffer.byteLength(String(file.content ?? ""), "utf8"), 0)

async function emitGeneratedFilesUpdate(input: {
  jobId: string
  stage: GenerationJobStage
  message: string
  allFiles: GeneratedFile[]
  previousFiles?: GeneratedFile[]
  changedFiles?: GeneratedFile[]
  deletedPaths?: string[]
  source: "seed" | "slice" | "repair" | "fast_fullstack_scaffold" | "backend_blueprint_scaffold"
  data?: Record<string, unknown>
}) {
  const allFilesBytes = totalFileBytes(input.allFiles)
  const changedPaths = (input.changedFiles || []).map((file) => normalizePath(file.path)).slice(0, 120)

  await GenerationJobService.appendEvent({
    jobId: input.jobId,
    type: "job.files.updated",
    stage: input.stage,
    status: "running",
    message: input.message,
    data: {
      source: input.source,
      fileCount: input.allFiles.length,
      deletedPaths: input.deletedPaths || [],
      totalBytes: allFilesBytes,
      changedPaths,
      paths: input.allFiles.map((file) => normalizePath(file.path)).slice(0, 120),
      ...(input.data || {}),
    },
  })
}

function createAgentWorkflowTools(initialFiles: GeneratedFile[], input: { projectId: string; signal?: AbortSignal }) {
  const byPath = new Map<string, GeneratedFile>()
  for (const file of initialFiles) {
    byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) })
  }

  const listFiles = (prefix = "") => {
    const normalizedPrefix = normalizePath(prefix)
    return Array.from(byPath.keys())
      .filter((path) => !normalizedPrefix || path.startsWith(normalizedPrefix))
      .sort()
  }

  const readFile = (path: string) => byPath.get(normalizePath(path))?.content ?? null

  const writeFile = (path: string, content: string, language?: GeneratedFile["language"]) => {
    const normalizedPath = normalizePath(path)
    byPath.set(normalizedPath, {
      path: normalizedPath,
      content,
      language: language || inferLanguageFromPath(normalizedPath),
    })
  }

  const searchFiles = (query: string, limit = 12) => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return []

    return Array.from(byPath.values())
      .filter((file) => {
        const path = normalizePath(file.path).toLowerCase()
        return path.includes(normalizedQuery) || String(file.content || "").toLowerCase().includes(normalizedQuery)
      })
      .map((file) => normalizePath(file.path))
      .slice(0, limit)
  }

  const snapshot = () => Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))

  const runCommand = async (command: RuntimeCommandName) => {
    const result = await runRuntimeCommand(input.projectId, snapshot(), command, { signal: input.signal })
    return {
      command,
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration: result.duration,
      reason: result.reason || null,
    }
  }

  return {
    listFiles,
    readFile,
    writeFile,
    searchFiles,
    runCommand,
    snapshot,
  }
}

function inferLanguageFromPath(path: string): GeneratedFile["language"] {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.endsWith(".md")) return "md"
  if (path.includes(".env")) return "env"
  return "ts"
}

function inferActiveTask(input: { prompt: string; plan: GenerationPlan; targetPaths: string[] }) {
  const paths = input.targetPaths.map(normalizePath)
  const text = input.prompt.toLowerCase()
  if (paths.some((path) => path === "prisma/schema.prisma" || /^lib\/db\//i.test(path))) {
    return "setup prisma"
  }
  if (paths.some((path) => /^app\/api\//i.test(path) && !/\/auth\/route\.ts$/i.test(path))) {
    return "create APIs"
  }
  if (paths.some((path) => /(^auth\.ts$|\/auth\/|app\/\(auth\)\/|admin\/users)/i.test(path))) {
    return "setup auth"
  }
  if (/\b(prisma|database|db|postgres|schema)\b/i.test(text)) return "setup prisma"
  if (/\b(api|route|crud|webhook|integration|integrasi)\b/i.test(text)) return "create APIs"
  if (/\b(auth|login|register|role|rbac|admin|user|session)\b/i.test(text)) return "setup auth"
  return input.plan.agentTasks.find((task) => task !== "setup project" && task !== "scope edit") || input.plan.agentTasks[0] || "setup project"
}

function contextBudgetForTask(task: string) {
  if (task === "setup auth" || task === "setup prisma") {
    return { maxFiles: 6, maxCharsPerFile: 1600, maxTotalChars: 8000 }
  }
  if (task === "create APIs") {
    return { maxFiles: 7, maxCharsPerFile: 1600, maxTotalChars: 10000 }
  }
  return { maxFiles: 8, maxCharsPerFile: 1600, maxTotalChars: 11000 }
}

function contextFileLimitForTask(task: string) {
  if (task === "setup auth" || task === "setup prisma") return 6
  if (task === "create APIs") return 7
  return 8
}

function coreContextFilesForTask(task: string) {
  if (task === "setup auth") {
    return ["package.json", "lib/auth/config.ts", "app/api/auth/route.ts", "prisma/schema.prisma"]
  }
  if (task === "create APIs") {
    return ["package.json", "prisma/schema.prisma"]
  }
  if (task === "setup prisma") {
    return ["package.json", "prisma/schema.prisma", "lib/db/client.ts"]
  }
  return ["package.json", "app/layout.tsx", "app/page.tsx"]
}

function isPathRelevantToTask(path: string, task: string, targetPaths: Set<string>) {
  if (targetPaths.has(path)) return true
  if (task === "setup auth") {
    return (
      path === "package.json" ||
      path === "prisma/schema.prisma" ||
      path === "lib/auth/config.ts" ||
      /^app\/api\/auth\/route\.ts$/i.test(path) ||
      /^app\/api\/admin\/users\/route\.ts$/i.test(path) ||
      /^app\/\(auth\)\//i.test(path) ||
      /(^|\/)(login|sign-in|sign-up|register|auth)(\/|\.|$)/i.test(path)
    )
  }
  if (task === "create APIs") {
    return (
      path === "package.json" ||
      path === "prisma/schema.prisma" ||
      /^app\/api\//i.test(path) ||
      /^lib\/services\//i.test(path) ||
      /^lib\/db\//i.test(path)
    )
  }
  if (task === "setup prisma") {
    return (
      path === "package.json" ||
      path === "prisma/schema.prisma" ||
      /^lib\/db\//i.test(path) ||
      /^lib\/services\//i.test(path)
    )
  }
  return true
}

function selectObservedFiles(input: {
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  buildLogs: string[]
  activeTask?: string
  targetPaths?: string[]
}) {
  const activeTask = input.activeTask || inferActiveTask({
    prompt: input.prompt,
    plan: input.plan,
    targetPaths: input.targetPaths || [],
  })
  const targetPathSet = new Set((input.targetPaths || []).map(normalizePath))
  const previewContext = trimContextForGeneration({
    prompt: input.prompt,
    files: input.files,
    layer: input.plan.objective === "simple_ui" ? "fast" : "builder",
    budget: contextBudgetForTask(activeTask),
  })
  const selected = new Map<string, string>()
  const add = (path: string, reason: string) => {
    const normalizedPath = normalizePath(path)
    if (normalizedPath && isPathRelevantToTask(normalizedPath, activeTask, targetPathSet)) {
      selected.set(normalizedPath, reason)
    }
  }

  for (const file of previewContext.files) {
    add(file.path, `ranked for active task: ${activeTask}`)
  }

  for (const file of input.plan.filePlan) {
    if (targetPathSet.size === 0 || targetPathSet.has(normalizePath(file.path))) {
      add(file.path, `planned target for active task: ${activeTask}`)
    }
  }

  for (const filePath of coreContextFilesForTask(activeTask)) {
    if (input.files.some((file) => normalizePath(file.path) === filePath)) {
      add(filePath, `core context for active task: ${activeTask}`)
    }
  }

  for (const logLine of input.buildLogs.slice(-20)) {
    for (const filePath of extractFilePathsFromError(logLine)) {
      add(filePath, "referenced by build or validation log")
    }
  }

  return Array.from(selected.entries())
    .slice(0, contextFileLimitForTask(activeTask))
    .map(([path, reason]) => ({ path, reason }))
}

function observeAgentContext(input: {
  prompt: string
  plan: GenerationPlan
  files: GeneratedFile[]
  buildLogs: string[]
  previousAttempts: AgentWorkflowMemoryEntry[]
  activeTask?: string
  targetPaths?: string[]
}): AgentWorkflowObservation {
  const activeTask = input.activeTask || inferActiveTask({
    prompt: input.prompt,
    plan: input.plan,
    targetPaths: input.targetPaths || [],
  })
  const targetPaths = (input.targetPaths || []).map(normalizePath)
  const selectedFiles = selectObservedFiles({ ...input, activeTask, targetPaths })
  const selectedPathSet = new Set(selectedFiles.map((selected) => selected.path))
  const fileContext = input.files
    .filter((file) => selectedPathSet.has(normalizePath(file.path)))
    .map((file) => ({
      path: normalizePath(file.path),
      language: file.language || inferLanguageFromPath(file.path),
      content: String(file.content || "").slice(0, 1600),
    }))
  const packageJson = parsePackageJsonFile(input.files)
  const dependencies = buildDependencyMap(
    input.files.filter((file) => selectedFiles.some((selected) => selected.path === normalizePath(file.path)))
  )
  const prismaFile = input.files.find((file) => normalizePath(file.path) === "prisma/schema.prisma")

  return {
    prompt: input.prompt,
    activeTask,
    targetPaths,
    blueprint: input.plan.blueprint,
    selectedFiles,
    fileContext,
    packageJson,
    dependencies,
    prismaSchema: {
      exists: Boolean(prismaFile),
      path: prismaFile ? normalizePath(prismaFile.path) : null,
      bytes: prismaFile ? Buffer.byteLength(prismaFile.content || "", "utf8") : 0,
    },
    buildLogs: input.buildLogs.slice(-20),
    previousAttempts: input.previousAttempts.slice(-MAX_AGENT_ITERATIONS),
  }
}

function summarizeAgentObservation(observation: AgentWorkflowObservation) {
  return {
    activeTask: observation.activeTask,
    targetPaths: observation.targetPaths,
    selectedFiles: observation.selectedFiles,
    fileContext: observation.fileContext.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content || "", "utf8"),
    })),
    packageJson: {
      exists: observation.packageJson.exists,
      dependencyCount: Object.keys(observation.packageJson.dependencies).length,
      devDependencyCount: Object.keys(observation.packageJson.devDependencies).length,
      parseError: observation.packageJson.parseError,
    },
    dependencyMap: {
      localImports: observation.dependencies.localImports.length,
      externalPackages: observation.dependencies.externalPackages,
      missingLocalImports: observation.dependencies.missingLocalImports.slice(0, 8),
      unsupportedPreviewImports: observation.dependencies.unsupportedPreviewImports.slice(0, 8),
    },
    prismaSchema: observation.prismaSchema,
    previousAttempts: observation.previousAttempts.map((attempt) => ({
      iteration: attempt.iteration,
      changedFiles: attempt.changedFiles,
      errors: attempt.errors,
      fixes: attempt.fixes,
    })),
  }
}

async function runProviderAttempt(input: {
  jobId: string
  projectId?: string | null
  prompt: string
  purpose: "generate" | "repair"
  orchestrationRole?: SoftwareOrchestrationRole
  logicalModel?: string
  selectedModel: string
  promptLanguage: "id" | "en"
  signal?: AbortSignal
  generationContext?: {
    projectId: string
    generationMode: string
    prompt: string
    previousPromptCount: number
    existingFiles: GeneratedFile[]
    existingFileCount?: number
  }
}) {
  const routed = routeModelForRequest({
    prompt: input.prompt,
    purpose: input.purpose,
  })
  const selectedTier = input.purpose === "generate" ? getSwiftTierConfig(input.selectedModel) : null
  const route = selectedTier
    ? {
        ...routed,
        modelName: selectedTier.key,
        layer: selectedTier.generationLayer,
        reason: `selected_generation_tier:${selectedTier.key}`,
      }
    : routed
  const startedAt = performance.now()
  const startedAtWall = Date.now()
  const correlation = createCorrelationIds({ correlationId: input.jobId })
  const traceContext = {
    taskId: input.jobId,
    sessionId: null,
    agentType: input.purpose,
    correlationId: correlation.correlationId,
    traceId: correlation.traceId,
    executionChainId: correlation.executionChainId,
  }
  traceExecution(traceContext, "provider_started", {
    projectId: input.projectId ?? input.generationContext?.projectId ?? null,
    purpose: input.purpose,
    model: route.modelName,
  })
  log("info", "generation_provider_attempt_started", {
    jobId: input.jobId,
    purpose: input.purpose,
    orchestrationRole: input.orchestrationRole || input.purpose,
    logicalModel: input.logicalModel || route.modelName,
    selectedModel: input.selectedModel,
    routedModel: route.modelName,
    layer: route.layer,
    classification: route.classification,
    reason: route.reason,
  })
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
      selectedModel: input.selectedModel,
      orchestrationRole: input.orchestrationRole || input.purpose,
      logicalModel: input.logicalModel || route.modelName,
    },
  })

  try {
    if (input.generationContext) {
      log("info", "generation_context", {
        projectId: input.generationContext.projectId,
        generationMode: input.generationContext.generationMode,
        prompt: input.generationContext.prompt,
        previousPromptCount: input.generationContext.previousPromptCount,
        existingFileCount: input.generationContext.existingFileCount ?? input.generationContext.existingFiles.length,
        files: summarizeContextFiles(input.generationContext.existingFiles).slice(0, 10),
      })
    }

    const response = await ProviderRouter.generate({
      provider: route.provider,
      modelName: route.modelName,
      prompt: input.prompt,
      mode: "files",
      promptLanguage: input.promptLanguage,
      signal: input.signal,
    })
    const endedAtWall = Date.now()
    const providerDurationMs = endedAtWall - startedAtWall
    recordOpenRouterLatency(providerDurationMs, {
      jobId: input.jobId,
      purpose: input.purpose,
      model: route.modelName,
    })
    warnIfSlow("openrouter", providerDurationMs, {
      jobId: input.jobId,
      purpose: input.purpose,
      model: route.modelName,
    })
    traceExecution(traceContext, "provider_finished", {
      projectId: input.projectId ?? input.generationContext?.projectId ?? null,
      purpose: input.purpose,
      model: route.modelName,
      durationMs: providerDurationMs,
      attempts: response.attempts.length,
    })
    log("info", "ai_response_received", {
      event: "ai_response_received",
      jobId: input.jobId,
      projectId: input.projectId ?? input.generationContext?.projectId ?? null,
      startedAt: new Date(startedAtWall).toISOString(),
      endedAt: new Date(endedAtWall).toISOString(),
      durationMs: providerDurationMs,
      purpose: input.purpose,
      provider: route.provider,
      model: route.modelName,
      latencyMs: Math.round(performance.now() - startedAt),
      attempts: response.attempts.length,
      tokenUsage: response.tokenUsage || null,
      rawLength: response.message.length,
      rawHash: hashText(response.message),
      RAW_AI_OUTPUT: runtimeLogText(response.message),
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
    const providerFailureMetadata =
      error instanceof SwiftProviderFailureError
        ? {
            selectedTier: error.selectedTier,
            providerAttempts: error.attempts,
            lastProviderAttempt: error.attempts.at(-1) || null,
          }
        : undefined
    if (providerFailureMetadata) {
      traceError(traceContext, error, {
        projectId: input.projectId ?? input.generationContext?.projectId ?? null,
        purpose: input.purpose,
        model: route.modelName,
      })
      log("error", "generation_provider_failover_exhausted", {
        jobId: input.jobId,
        purpose: input.purpose,
        ...providerFailureMetadata,
      })
    }
    await GenerationJobService.finishAttempt({
      jobId: input.jobId,
      sequence: attempt.sequence,
      status: error instanceof GenerationJobCancelledError ? "cancelled" : "failed",
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      metadata: providerFailureMetadata,
    })
    throw error
  }
}

function buildSlicePrompt(input: {
  prompt: string
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
  existingFiles: GeneratedFile[]
  projectStateBlock?: string
  target: GenerationPlannerFile
  targets?: GenerationPlannerFile[]
  observation?: AgentWorkflowObservation
}) {
  const context = formatObservedTaskContext(input.prompt, input.observation)
  const targets = input.targets && input.targets.length > 0 ? input.targets : [input.target]
  const targetPaths = targets.map((target) => target.path)
  const batchedFoundation = targets.length > 1
  const productionFullStack = input.plan.productionMode === "production_fullstack"
  const fullFrontend = input.plan.productionMode === "full_frontend"
  const intentTemplate = selectIntentTemplate(input.prompt)

  return [
    context,
    "",
    buildIntentInstructionBlock(input.plan.intent),
    "",
    buildDynamicSeedDirective(input.prompt),
    "",
    buildBlueprintInstructionBlock(input.blueprint),
    "",
    "INTENT_TEMPLATE_LIBRARY:",
    JSON.stringify(
      intentTemplate
        ? {
            selectedTemplate: intentTemplate.id,
            templatePath: intentTemplate.path,
            requiredCapabilities: intentTemplate.requiredCapabilities,
            instruction: "Use this intent template as the domain skeleton. Adapt copy and data to the user's prompt without changing the compile gate.",
          }
        : {
            selectedTemplate: null,
            availableTemplates: ["landing", "dashboard", "marketplace", "saas", "crm", "restaurant", "clinic", "laundry", "blog"],
          },
      null,
      2
    ),
    "",
    "COMPONENT_REGISTRY_CONTRACTS:",
    JSON.stringify(componentRegistryPromptPayload(), null, 2),
    "",
    buildArchitectureInstructionBlock(input.plan.architecture),
    "",
    buildRoleInstructionBlock({
      diagnostics: input.plan.orchestration,
      role: "builder",
    }),
    "",
    buildPartialEditInstructionBlock(input.plan.editPlan),
    "",
    input.projectStateBlock || "",
    input.projectStateBlock ? "" : "",
    "EXECUTION_RULES:",
    productionFullStack
      ? "- PRODUCTION_FULLSTACK_MODE: generate a deployable full-stack slice with visible UI, route handlers, Prisma/data layer, env example, and package config as requested. Do not downgrade to dummy-only preview."
      : fullFrontend
        ? "- FULL_FRONTEND_MODE: generate production-like frontend architecture with reusable components, realistic UI composition, responsive navigation, footer, CTA, loading/empty states, and domain-specific sections."
        : "- PREVIEW_MODE: generate a small explicit preview prototype only when the user asks for a quick preview.",
    `- STAGED_GENERATION_PHASE: ${input.target.stage || "support"}.`,
    input.target.stage === "scaffold"
      ? "- TAHAP_1_SCAFFOLD_ONLY: generate only valid Next.js App Router scaffold/config files. Validation is atomic and will run after planned dependency files exist."
      : input.target.stage === "routes"
        ? "- TAHAP_2_ROUTES_ONLY: generate only ecommerce route page files for products, product detail, cart, checkout, login, or admin. Do not create components yet; use small in-file placeholders and keep imports local to existing scaffold only."
        : input.target.stage === "components"
          ? "- TAHAP_3_COMPONENTS_ONLY: generate only Navbar, ProductCard, ProductGrid, CartDrawer, or CheckoutForm with dummy data-friendly props. Do not add Supabase or Turso integration yet."
          : input.target.stage === "supabase"
            ? "- TAHAP_4_SUPABASE_ONLY: add Supabase auth/database integration boundaries only after scaffold, routes, and components are valid."
            : input.target.stage === "turso"
              ? "- TAHAP_5_TURSO_ONLY: add Turso lightweight transaction boundaries only after Supabase stage."
              : "- SUPPORT_STAGE: keep changes scoped to the requested support file.",
    batchedFoundation
      ? `- BATCHED_SLICE: create or modify ONLY these ${targets.length} files in this provider call: ${targetPaths.join(", ")}.`
      : "- Work only on the requested file slice and directly related imports.",
    productionFullStack
      ? `- Production pass budget: this job may create up to ${input.plan.maxFilesThisPass} files across batched slices.`
      : fullFrontend
        ? `- Full frontend budget: this job may create ${Math.min(8, input.plan.maxFilesThisPass)}-${input.plan.maxFilesThisPass} files across app/, components/, sections/, and lib/.`
        : `- Explicit preview budget: the generation plan is capped at ${PREVIEW_FOUNDATION_FILE_LIMIT} files.`,
    productionFullStack && batchedFoundation
      ? `- For this provider call, return exactly ${targets.length} create/modify operations, one per listed target file. Do not skip API, Prisma, service, hook, or page targets.`
      : batchedFoundation
        ? `- For this provider call, return at most ${targets.length} create/modify operations, one per listed target file.`
        : productionFullStack
          ? "- For this provider call, return the requested file and any direct imports required to keep this production slice buildable."
          : "- For this provider call, return exactly one create/modify operation for Current file objective unless a direct import fix is required.",
    productionFullStack
      ? "- Use the existing locked stack. You MAY use Prisma schema, server-only service files, Route Handlers, NextAuth-compatible placeholders, and payment/API integration placeholders when the prompt asks for them."
      : fullFrontend
        ? "- Use the existing Tailwind and shadcn/ui-compatible stack. Build component hierarchy instead of a single-page demo. Do not introduce backend libraries in FULL_FRONTEND_MODE."
        : "- Never install or introduce new libraries in explicit preview mode; use the existing Tailwind and shadcn/ui-compatible stack.",
    "- NEXTAUTH_PATH_POLICY: never create or modify next-auth.d.ts, root auth.ts, or any .env file from generated artifacts. Put NextAuth runtime/config changes in route handlers under app/ or helper modules under lib/.",
    productionFullStack
      ? "- Do not use UI-only dummy output. If real external credentials are not available, create server-side integration boundaries, env placeholders, zod validation, and clear TODO-safe service functions instead of fake-only UI."
      : fullFrontend
        ? "- Use realistic domain data from lib/data.ts or typed local data modules. Avoid generic dummy-first output and never collapse the UI into one file."
        : "- Preview mock data is allowed only inside the generated preview file.",
    productionFullStack
      ? "- MOCK_DATA_FORBIDDEN_IN_UI: do not create const dummy*, mock*, fake*, or sample* arrays in app pages/components. Pages must call local service/API boundaries or render empty/loading/error states backed by typed service contracts."
      : fullFrontend
        ? "- FULL_FRONTEND_DATA_POLICY: realistic local data is allowed in lib/data.ts; avoid generic dummy/mock/fake naming and placeholder copy."
        : "- Preview mock data is allowed only inside the generated preview file.",
    productionFullStack && input.plan.appType === "clinic_management"
      ? "- CLINIC_FULLSTACK_REQUIRED: include dashboard, patients, doctors, appointments, auth/roles, Prisma schema, clinic service, BPJS integration service/route, and a hook or component boundary as planned."
      : "- Follow the controlled app blueprint exactly.",
    "- Keep each returned file under 4000 output tokens when possible.",
    "- Stop after the requested slice; do not create extra support files speculatively.",
    "- APPROVED_SCOPE_ONLY: create or modify files only when their exact canonical path appears in APPROVED_FILE_SCOPE_CONTRACT.allowedPaths.",
    "- HELPER_FILE_POLICY: helper/shell files are explicit-only. Do not create components/app-shell.tsx, components/*-shell.tsx, or components/*helper*.tsx unless that exact path appears in APPROVED_FILE_SCOPE_CONTRACT.allowedPaths.",
    "- COMPONENT_REGISTRY_POLICY: compose standard UI from component-registry/* when a matching registry component exists. Do not recreate HeroSection, Navbar, Footer, DashboardCard, FeatureSection, Testimonial, or Pricing from scratch.",
    "- COMPONENT_REGISTRY_POLICY: registry components have required props, optional props, default props, import dependencies, and client/server type contracts. Pass every required prop with the expected type before render.",
    "- COMPONENT_REGISTRY_POLICY: import standard components from their registry importPath and keep dependency graph intact: app/page.tsx -> component-registry/* -> any direct dependency.",
    "- PATH POLICY: every path must be canonical workspace-relative POSIX form, and must start with src/, app/, components/, sections/, component-registry/, lib/, prisma/, or an allowlisted root file such as package.json, tsconfig.json, next.config.ts, tailwind.config.ts, postcss.config.js, README.md, or .env.example. Use app/page.tsx, component-registry/hero.tsx, sections/HeroSection.tsx, components/Button.tsx, lib/utils.ts, or package.json; never use /app/page.tsx, ./components/Button.tsx, or ../lib/utils.ts.",
    "- BLOCKED PATHS: never use .., ~, absolute paths, node_modules, .env files, .git, package-lock.json, pnpm-lock.yaml, or yarn.lock.",
    "- STRICT_ARTIFACT_ENVELOPE: Return ONLY a JSON object parseable directly by JSON.parse. No markdown fences. No prose. No explanations. No comments outside JSON. No preamble like Here is your app.",
    '- Required PATCH schema: {"taskGraph":{"operations":[{"operation":"modifyFile","file":"components/Navbar.tsx","content":"full updated file content"}]}}.',
    '- For tiny deterministic edits, use patchFile: {"operation":"patchFile","file":"components/Navbar.tsx","changes":[{"line":35,"replace":"Dashboard"}]}.',
    "- The root object must contain taskGraph.operations. Do not rewrite the full project. Do not return more than 5 changed files.",
    "- Framework labels such as Next.js, React, and TypeScript belong in framework/metadata, never in files[].path or taskGraph.operations[].path.",
    "- Never ask to run shell commands or mutate files outside the files array.",
    "- TSX_PARSE_LOCK: every returned .tsx/.ts/.jsx/.js file must parse with @babel/parser using jsx + typescript plugins.",
    "- RENDER_SAFE_RULES: app/layout.tsx and app/page.tsx must always exist in the final artifact and must render successfully in Next.js App Router.",
    "- RENDER_SAFE_RULES: provider wrappers are mandatory when context, createContext, useContext, theme/session/query providers, or dependency-level providers are used.",
    "- RENDER_SAFE_RULES: use \"use client\" only for files that use client-only React APIs, browser APIs, event handlers, or context creation.",
    "- RENDER_SAFE_RULES: automatically inject the nearest context Provider into app/layout.tsx or app/page.tsx when any dependency requires that provider.",
    "- Do not use raw emoji or decorative non-ASCII symbols in TSX code. Use plain text labels or imported icons only.",
    "- Never split quoted strings across physical lines. Put long copy in JSX text nodes, arrays of short strings, or properly closed template literals.",
    "- Keep generated code ASCII-safe unless the user explicitly asks for local script characters.",
    "- Prefer task graph operations over raw files.",
    "- Prefer patch-safe, deterministic updates.",
    "- Preserve stable files unless this slice requires a focused update.",
    batchedFoundation || fullFrontend
      ? "- Keep imports resolvable within the final approved scaffold. Imports to files listed in the same generation plan are allowed; final validation runs after the batch graph is complete."
      : "- Keep the app deployable after this slice: no unresolved imports, no forbidden stack drift.",
    `- Current file objective: ${input.target.path}`,
    `- Why this file matters: ${input.target.reason}`,
    `- Allowed target files for this provider call: ${targetPaths.join(", ")}`,
    `- Planned objective: ${input.plan.objective}`,
    `- Generation mode: ${input.plan.generationMode}`,
    `- Incremental edit intent: ${input.plan.incrementalEdit.editIntent || "none"}`,
    `- Controlled app type: ${input.plan.appType}`,
    "",
    "APPROVED_FILE_SCOPE_CONTRACT:",
    JSON.stringify(input.plan.allowedFileScope, null, 2),
    "",
    "SCOPED_GENERATION_REQUEST:",
    JSON.stringify(
      {
        targetFiles: targetPaths,
        exactPurpose: input.target.reason,
        allowedFileScope: input.plan.allowedFileScope.allowedPaths,
        allowedImports: [
          "react",
          "next/link",
          "next/navigation",
          "lucide-react",
          "@/components/* only when the imported file is in ALLOWED_FILE_SCOPE",
          "@/sections/* only when the imported file is in ALLOWED_FILE_SCOPE",
          "@/lib/* only when the imported file is in ALLOWED_FILE_SCOPE",
        ],
        allowedExports: ["default React component for route files", "named React component matching component filename"],
        allowedDependencies: input.plan.architecture.dependencies,
        forbiddenPatterns: input.plan.orchestration.architectureOutput.forbiddenPatterns,
      },
      null,
      2
    ),
    "",
    "AGENT_WORKFLOW_CONTEXT:",
    JSON.stringify(
      {
        tasks: input.plan.agentTasks,
        actionPlan: input.plan.actionPlan,
        incrementalEdit: input.plan.incrementalEdit,
        projectMemory: input.plan.projectMemory,
        dependencyGraph: input.plan.dependencyGraph,
        observation: input.observation ? summarizeAgentObservation(input.observation) : null,
      },
      null,
      2
    ),
  ].join("\n")
}

function formatObservedTaskContext(prompt: string, observation?: AgentWorkflowObservation) {
  if (!observation) {
    return prompt
  }

  const fileContext = observation.fileContext
    .map((file) => `FILE: ${file.path}\n${file.content}`)
    .join("\n\n")
  return [
    prompt,
    "",
    "### TASK_SCOPED_CONTEXT",
    JSON.stringify(
      {
        activeTask: observation.activeTask,
        targetPaths: observation.targetPaths,
        selectedFiles: observation.selectedFiles,
      },
      null,
      2
    ),
    fileContext ? `\n### RELEVANT_FILES\n${fileContext}` : "",
  ].filter(Boolean).join("\n")
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

  const graph = buildImportGraph(files)
  const repairScope = new Set<string>()
  for (const filePath of failing) {
    for (const impactPath of getTransitiveImpactPaths(graph, [filePath], {
      direction: "both",
      maxDepth: 1,
      maxFiles: MAX_FILES_PER_REPAIR,
    })) {
      repairScope.add(normalizePath(impactPath))
    }
  }

  const matchedFiles = files
    .filter((file) => failing.has(normalizePath(file.path)) || repairScope.has(normalizePath(file.path)))
    .slice(0, MAX_FILES_PER_REPAIR)
  if (matchedFiles.length > 0) {
    return matchedFiles
  }

  return files
    .filter((file) =>
      /^app\/(?:.+\/)?page\.(tsx|ts|jsx|js)$/i.test(normalizePath(file.path)) ||
      /^components\//i.test(normalizePath(file.path)) ||
      normalizePath(file.path) === "package.json"
    )
    .slice(0, MAX_FILES_PER_REPAIR)
}

function extractRequestedFilePaths(prompt: string) {
  const paths = new Set<string>()
  const pattern = /(?:^|[\s:`"'(])([A-Za-z0-9_./[\]()-]+\.(?:tsx?|jsx?|json|css|prisma|md|env))(?:\b|$)/gim

  for (const match of String(prompt || "").matchAll(pattern)) {
    if (match[1]) {
      const path = safeGeneratedPath(match[1])
      if (path) paths.add(path)
    }
  }

  return Array.from(paths)
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

function safeGeneratedPath(value: string) {
  try {
    return validateGeneratedPath(value).path
  } catch {
    return null
  }
}

function stagedPhaseForPath(path: string, appType?: string): StagedGenerationPhase {
  const normalized = normalizePath(path).toLowerCase()
  if (
    normalized === "app/layout.tsx" ||
    normalized === "app/page.tsx" ||
    normalized === "app/globals.css" ||
    normalized === "package.json" ||
    normalized === "tsconfig.json" ||
    normalized === "tailwind.config.ts"
  ) {
    return "scaffold"
  }
  if (appType === "ecommerce" && /^app\/(?:products(?:\/\[id\])?|cart|checkout|login|admin)\/page\.(tsx|ts|jsx|js)$/i.test(normalized)) {
    return "routes"
  }
  if (appType === "ecommerce" && /^components\/(?:navbar|productcard|productgrid|cartdrawer|checkoutform|product-card|product-grid|cart-drawer|checkout-form)\.(tsx|ts|jsx|js)$/i.test(normalized)) {
    return "components"
  }
  if (/supabase/i.test(normalized)) return "supabase"
  if (/turso|libsql/i.test(normalized)) return "turso"
  return "support"
}

function generationDependencyOrder(path: string, productionMode: GenerationPlan["productionMode"]) {
  const normalized = normalizePath(path).toLowerCase()
  if (productionMode !== "full_frontend" && productionMode !== "production_fullstack") {
    return 50
  }
  if (normalized === "package.json" || normalized === "tsconfig.json" || normalized.startsWith("lib/")) return 0
  if (normalized.startsWith("components/") || normalized.startsWith("sections/")) return 10
  if (normalized === "app/globals.css") return 20
  if (normalized === "app/layout.tsx") return 30
  if (normalized.startsWith("app/")) return 40
  return 50
}

function isEcommerceStagedPlan(plan: GenerationPlan) {
  return plan.orchestration.plannerOutput.appType === "ecommerce" && plan.editPlan.mode === "full"
}

function stagedPhaseLabel(phase: StagedGenerationPhase) {
  const labels: Record<StagedGenerationPhase, string> = {
    scaffold: "Tahap 1: scaffold",
    routes: "Tahap 2: ecommerce routes",
    components: "Tahap 3: ecommerce components",
    supabase: "Tahap 4: Supabase integration",
    turso: "Tahap 5: Turso lightweight transactions",
    support: "Support files",
  }
  return labels[phase]
}

function validateStagedCheckpoint(input: {
  phase: StagedGenerationPhase
  files: GeneratedFile[]
  plan: GenerationPlan
}) {
  const paths = new Set(input.files.map((file) => normalizePath(file.path)))
  const failures: string[] = []

  if (input.phase === "scaffold") {
    const scaffold = validateProjectScaffold({ paths: Array.from(paths) })
    failures.push(...scaffold.missingFiles.map((file) => `Missing scaffold file: ${file}`))
    const hasPendingPlannedDependencies = input.plan.filePlan.some((file) => {
      const normalized = normalizePath(file.path)
      return !paths.has(normalized) && /^(components|sections|lib|app)\//i.test(normalized)
    })
    if (!hasPendingPlannedDependencies) {
      try {
        compileProject(input.files)
      } catch (error) {
        failures.push(`Scaffold preview failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (input.phase === "routes") {
    for (const route of [
      "app/products/page.tsx",
      "app/products/[id]/page.tsx",
      "app/cart/page.tsx",
      "app/checkout/page.tsx",
      "app/login/page.tsx",
      "app/admin/page.tsx",
    ]) {
      if (!paths.has(route)) failures.push(`Missing ecommerce route: ${route}`)
    }
  }

  if (input.phase === "components") {
    for (const component of [
      "components/Navbar.tsx",
      "components/ProductCard.tsx",
      "components/ProductGrid.tsx",
      "components/CartDrawer.tsx",
      "components/CheckoutForm.tsx",
    ]) {
      if (!paths.has(component)) failures.push(`Missing ecommerce component: ${component}`)
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  }
}

function auditPostGeneration(input: {
  plan: GenerationPlan
  generatedFiles: GeneratedFile[]
  persistedFiles: GeneratedFile[]
  previewUrl: string | null
  previewStatus: string | null
}) {
  const failures: string[] = []
  const persistedPaths = new Set(input.persistedFiles.map((file) => normalizePath(file.path)))
  const generatedPaths = new Set(input.generatedFiles.map((file) => normalizePath(file.path)))

  if (input.generatedFiles.length === 0) failures.push("generatedFiles.length is 0")
  if (input.persistedFiles.length === 0) failures.push("persisted file count is 0")

  for (const path of generatedPaths) {
    if (!persistedPaths.has(path)) failures.push(`Generated file was not persisted: ${path}`)
  }

  if (input.plan.orchestration.plannerOutput.appType === "ecommerce") {
    for (const requiredFile of ecommerceRequiredFiles()) {
      if (!persistedPaths.has(requiredFile)) failures.push(`Missing ecommerce required file after persistence: ${requiredFile}`)
    }
  }

  failures.push(
    ...validateGeneratedUXQuality({
      plan: input.plan.orchestration.plannerOutput.uxProductPlan,
      files: input.persistedFiles,
    })
  )

  const previewStatus = String(input.previewStatus || "")
  const acceptsBrowserPreviewOnly =
    isProductionVercel() &&
    input.persistedFiles.length > 0 &&
    process.env.SWIFT_REQUIRE_SANDBOX_FOR_PRODUCTION_FULLSTACK !== "true"

  if (!input.previewUrl && !/ready|running|success|passed|browser-preview-only/i.test(previewStatus) && !acceptsBrowserPreviewOnly) {
    failures.push("Preview did not boot successfully")
  }

  return {
    ok: failures.length === 0,
    failures,
    fileCount: input.persistedFiles.length,
    requiredFiles: input.plan.orchestration.plannerOutput.appType === "ecommerce" ? ecommerceRequiredFiles() : [],
    previewMode: input.previewUrl
      ? "runtime-sandbox"
      : /browser-preview-only/i.test(previewStatus) || acceptsBrowserPreviewOnly
        ? "browser-preview-only"
        : "unavailable",
  }
}

async function verifyProjectStateCommit(input: {
  projectId: string
  historyId: string
  generatedFiles: GeneratedFile[]
  plan: GenerationPlan
}): Promise<ProjectStateCommitDiagnostics> {
  const generatedFiles = ProjectFilesystemService.normalizeFiles(input.generatedFiles)
  const committedFiles = await ProjectFilesystemService.readFiles(input.projectId)
  const generatedManifest = ProjectFilesystemService.buildManifest(generatedFiles)
  const committedManifest = ProjectFilesystemService.buildManifest(committedFiles)
  const committedHashes = committedManifest.fileHashes
  const failedWritePaths = generatedManifest.paths.filter(
    (filePath) => committedHashes[filePath] !== generatedManifest.fileHashes[filePath]
  )
  const requiredFiles = requiredFilesForCommittedProject(input.plan)
  const committedPaths = new Set(committedFiles.map((file) => normalizePath(file.path)))
  const requiredFilesMissing = requiredFiles.filter((filePath) => !committedPaths.has(filePath))

  const diagnostics: ProjectStateCommitDiagnostics = {
    generatedFileCount: generatedFiles.length,
    committedFileCount: committedFiles.length,
    persistedSnapshotId: input.historyId,
    failedWritePaths,
    requiredFilesMissing,
    manifest: committedManifest,
  }

  if (generatedFiles.length === 0) {
    throw new Error(`Project state commit failed: generated file count is 0 for snapshot ${input.historyId}`)
  }

  if (committedFiles.length === 0) {
    throw new Error(`Project state commit failed: persisted project state is empty for snapshot ${input.historyId}`)
  }

  if (failedWritePaths.length > 0) {
    throw new Error(`Project state commit failed: write verification mismatch for ${failedWritePaths.join(", ")}`)
  }

  if (requiredFilesMissing.length > 0) {
    throw new Error(`Project state commit failed: required files missing after reload: ${requiredFilesMissing.join(", ")}`)
  }

  return diagnostics
}

function requiredFilesForCommittedProject(plan: GenerationPlan) {
  const required = plan.editPlan.mode === "partial"
    ? plan.editPlan.targetPaths
    : plan.filePlan.map((file) => file.path)
  return uniquePaths(required)
}

function validateGeneratedFilesAgainstAllowedScope(input: {
  files: GeneratedFile[]
  plan: GenerationPlan
}) {
  const allowed = new Set(input.plan.orchestration.allowedScope.map(normalizePath))
  const forbiddenPatterns = input.plan.orchestration.architectureOutput.forbiddenPatterns
  const rejected: Array<{ path: string; reason: string }> = []
  const accepted: GeneratedFile[] = []

  for (const file of input.files) {
    const path = normalizePath(file.path)
    const forbidden = forbiddenPatterns.find((pattern) => path.includes(pattern))
    if (forbidden) {
      rejected.push({ path, reason: `Forbidden pattern matched: ${forbidden}` })
      continue
    }
    if (!allowed.has(path)) {
      rejected.push({ path, reason: "File is outside ALLOWED_FILE_SCOPE" })
      continue
    }
    accepted.push({ ...file, path })
  }

  const existingAcceptedPaths = new Set(accepted.map((file) => normalizePath(file.path)))
  const missingRequired = input.plan.orchestration.architectureOutput.requiredFiles
    .map(normalizePath)
    .filter((path) => allowed.has(path) && !existingAcceptedPaths.has(path))

  return {
    ok: rejected.length === 0,
    accepted,
    rejected,
    missingRequired,
  }
}

function scopeArtifactToAllowedScope(
  artifact: ReturnType<typeof parseGeneratedArtifact>,
  plan: GenerationPlan
): {
  artifact: ReturnType<typeof parseGeneratedArtifact>
  rejected: Array<{ path: string; reason: string }>
} {
  const fileValidation = validateGeneratedFilesAgainstAllowedScope({ files: artifact.files, plan })
  const allowed = new Set(plan.orchestration.allowedScope.map(normalizePath))
  const forbiddenPatterns = plan.orchestration.architectureOutput.forbiddenPatterns
  const rejected = [...fileValidation.rejected]

  if (!artifact.taskGraph) {
    return {
      artifact: {
        ...artifact,
        files: fileValidation.accepted,
      },
      rejected,
    }
  }

  const operations = artifact.taskGraph.operations.filter((operation) => {
    const path = normalizePath(operation.path)
    const forbidden = forbiddenPatterns.find((pattern) => path.includes(pattern))
    if (forbidden) {
      rejected.push({ path, reason: `Forbidden taskGraph path pattern matched: ${forbidden}` })
      return false
    }
    if (!allowed.has(path)) {
      rejected.push({ path, reason: "taskGraph operation is outside ALLOWED_FILE_SCOPE" })
      return false
    }
    return true
  }).map((operation) => ({ ...operation, path: normalizePath(operation.path) }))

  return {
    artifact: {
      ...artifact,
      files: fileValidation.accepted,
      taskGraph: {
        ...artifact.taskGraph,
        operations,
      },
    },
    rejected,
  }
}

function ecommerceRequiredFiles() {
  return [
    "app/layout.tsx",
    "app/page.tsx",
    "app/products/page.tsx",
    "app/products/[id]/page.tsx",
    "app/cart/page.tsx",
    "app/checkout/page.tsx",
    "app/login/page.tsx",
    "app/admin/page.tsx",
    "components/Navbar.tsx",
    "components/ProductCard.tsx",
    "components/ProductGrid.tsx",
    "components/CartDrawer.tsx",
    "components/CheckoutForm.tsx",
  ]
}

function buildMissingScaffoldFiles(missingFiles: string[]): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const missing = new Set(missingFiles.map((file) => file.toLowerCase()))

  if (missing.has("app/layout.tsx")) {
    files.push({
      path: "app/layout.tsx",
      language: "tsx",
      content: `import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

export const metadata: Metadata = {
  title: "Swift App",
  description: "Generated with Swift orchestration.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,
    })
  }

  if (missing.has("app/page.tsx")) {
    files.push({
      path: "app/page.tsx",
      language: "tsx",
      content: `export default function HomePage() {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <section className="mx-auto grid max-w-5xl gap-4">
        <p className="text-sm font-medium text-muted-foreground">Swift scaffold ready</p>
        <h1 className="text-3xl font-semibold tracking-normal">Your app is ready for scoped generation.</h1>
      </section>
    </main>
  )
}
`,
    })
  }

  if (missing.has("app/globals.css")) {
    files.push({
      path: "app/globals.css",
      language: "css",
      content: `@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #111827;
  --muted-foreground: #6b7280;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}
`,
    })
  }

  if (missing.has("package.json")) {
    files.push({
      path: "package.json",
      language: "json",
      content: `${JSON.stringify(
        {
          name: "swift-generated-app",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            next: "16.2.6",
            react: "19.2.5",
            "react-dom": "19.2.5",
          },
          devDependencies: {
            typescript: "5.7.3",
            "@types/node": "^22",
            "@types/react": "19.2.14",
            "@types/react-dom": "19.2.3",
            tailwindcss: "^4.2.0",
            "@tailwindcss/postcss": "^4.2.0",
          },
        },
        null,
        2
      )}\n`,
    })
  }

  if (missing.has("tsconfig.json")) {
    files.push({
      path: "tsconfig.json",
      language: "json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "react-jsx",
            incremental: true,
            paths: {
              "@/*": ["./*"],
            },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2
      )}\n`,
    })
  }

  if (missing.has("tailwind.config.ts")) {
    files.push({
      path: "tailwind.config.ts",
      language: "ts",
      content: `import type { Config } from "tailwindcss"

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
`,
    })
  }

  if (missing.has("components/loading-skeleton.tsx")) {
    files.push({
      path: "components/loading-skeleton.tsx",
      language: "tsx",
      content: `export function LoadingSkeleton() {
  return (
    <div className="grid gap-3" aria-label="Loading">
      <div className="h-4 w-28 rounded bg-slate-200" />
      <div className="h-24 rounded border border-slate-200 bg-slate-50" />
    </div>
  )
}
`,
    })
  }

  if (missing.has("components/site-footer.tsx")) {
    files.push({
      path: "components/site-footer.tsx",
      language: "tsx",
      content: `export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 px-6 py-6 text-sm text-slate-600">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>Swift generated app</span>
        <span>Production-ready fallback scaffold</span>
      </div>
    </footer>
  )
}
`,
    })
  }

  if (missing.has("lib/data.ts")) {
    files.push({
      path: "lib/data.ts",
      language: "ts",
      content: `export const appData = {
  title: "Swift App",
  description: "A minimal runnable project recovered from the generation pipeline.",
  cta: "Get started",
  sections: ["hero", "features", "benefit", "pricing", "faq", "contact"],
}
`,
    })
  }

  return files
}

function fallbackComponentExportName(path: string) {
  const base = normalizePath(path)
    .split("/")
    .pop()
    ?.replace(/\.(tsx|jsx|ts|js)$/i, "") || "generated-section"
  return base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("") || "GeneratedSection"
}

function buildGenericFallbackFile(path: string): GeneratedFile | null {
  const normalized = normalizePath(path)
  const known = buildMissingScaffoldFiles([normalized])
  if (known.length > 0) return known[0]

  if (/^components\/.+\.(tsx|jsx)$/i.test(normalized) || /^sections\/.+\.(tsx|jsx)$/i.test(normalized)) {
    const exportName = fallbackComponentExportName(normalized)
    const label = normalized
      .replace(/\.(tsx|jsx)$/i, "")
      .replace(/^(components|sections)\//, "")
      .replace(/[-_/]+/g, " ")
    return {
      path: normalized,
      language: "tsx",
      content: `export function ${exportName}() {
  return (
    <section className="grid gap-3 rounded border border-slate-200 bg-white p-5">
      <p className="text-sm font-medium uppercase tracking-normal text-slate-500">${label}</p>
      <h2 className="text-xl font-semibold text-slate-950">Reliable ${label} section</h2>
      <p className="text-sm leading-6 text-slate-600">Responsive fallback content for hero, features, benefit, pricing, faq, contact, and cta coverage.</p>
    </section>
  )
}

export default ${exportName}
`,
    }
  }

  if (/^app\/(?:.+\/)?page\.(tsx|jsx)$/i.test(normalized)) {
    return {
      path: normalized,
      language: "tsx",
      content: `export default function GeneratedPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-10 text-slate-950">
      <section className="mx-auto grid max-w-4xl gap-4">
        <p className="text-sm font-medium uppercase tracking-normal text-slate-500">Swift fallback</p>
        <h1 className="text-3xl font-semibold">Generated page recovered</h1>
        <p className="text-base text-slate-600">This route is running with a minimal fallback page.</p>
      </section>
    </main>
  )
}
`,
    }
  }

  if (normalized === ".env.example") {
    return {
      path: ".env.example",
      language: "env",
      content: `# Add runtime environment variables here when needed.
`,
    }
  }

  return null
}

function buildMinimalRunnableFallbackProject(input: {
  files: GeneratedFile[]
  plan?: GenerationPlan
  reason: string
  replaceCore?: boolean
}) {
  const required = uniquePaths([
    ...MINIMAL_RUNNABLE_FALLBACK_REQUIRED_FILES,
    ...MINIMAL_RUNNABLE_FALLBACK_SUPPORT_FILES,
    ...(input.plan?.filePlan.map((file) => file.path) || []),
    ...(input.plan?.blueprint.requiredFiles || []),
  ])
  const fallbackFiles = required
    .map((path) => buildGenericFallbackFile(path))
    .filter(Boolean) as GeneratedFile[]
  const fallbackByPath = new Map(fallbackFiles.map((file) => [normalizePath(file.path), file]))
  const existingByPath = new Map(input.files.map((file) => [normalizePath(file.path), file]))
  const merged = new Map(existingByPath)
  const injectedPaths: string[] = []

  for (const [path, file] of fallbackByPath) {
    if (!existingByPath.has(path) || input.replaceCore) {
      merged.set(path, file)
      injectedPaths.push(path)
    }
  }

  return {
    files: Array.from(merged.values()),
    injectedPaths: uniquePaths(injectedPaths),
    requiredFiles: required,
    missingBefore: required.filter((path) => !existingByPath.has(normalizePath(path))),
    reason: input.reason,
  }
}

function buildMissingBackendBlueprintFiles(input: {
  plan: GenerationPlan
  prompt: string
  files: GeneratedFile[]
}): GeneratedFile[] {
  if (input.plan.productionMode !== "production_fullstack") return []

  const text = input.prompt.toLowerCase()
  const paths = new Set(input.files.map((file) => normalizePath(file.path)))
  const planned = new Set([
    ...input.plan.filePlan.map((file) => normalizePath(file.path)),
    ...input.plan.blueprint.requiredFiles.map(normalizePath),
    ...input.plan.architecture.backend.apiRoutes.map(normalizePath),
    ...input.plan.architecture.backend.services.map(normalizePath),
    input.plan.architecture.database.schema,
  ].filter((filePath) => filePath && filePath !== "none"))
  const shouldScaffoldCommerceBackend =
    input.plan.appType === "simple_marketplace" ||
    input.plan.orchestration.plannerOutput.appType === "ecommerce" ||
    /\b(product|produk|marketplace|e-?commerce|seller|buyer|catalog|katalog|cart|checkout|user|auth|login|admin)\b/i.test(text) ||
    planned.has("app/api/products/route.ts") ||
    planned.has("lib/services/product.service.ts")

  if (!shouldScaffoldCommerceBackend) return []

  const filesByPath = new Map<string, GeneratedFile>()
  const addIfMissing = (file: GeneratedFile) => {
    const path = normalizePath(file.path)
    if (!paths.has(path)) filesByPath.set(path, { ...file, path })
  }

  addIfMissing(buildCommercePrismaSchemaFile())
  addIfMissing(buildProductServiceFile())
  addIfMissing(buildUserServiceFile())
  addIfMissing(buildProductsApiRouteFile())
  addIfMissing(buildUsersApiRouteFile())

  return Array.from(filesByPath.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function extractUiMockDataToServices(files: GeneratedFile[]) {
  return files.map((file) => {
    const path = normalizePath(file.path)
    if (!/^app\/(?:.+\/)?page\.tsx$/i.test(path)) return file
    if (/^\s*["']use client["']/m.test(file.content)) return file
    if (!/\bconst\s+products\s*=\s*\[[\s\S]*?\]\s*(?:\n|$)/m.test(file.content)) return file
    if (/from\s+["']@\/lib\/services\/product\.service["']/.test(file.content)) return file

    let content = file.content.replace(/\bconst\s+products\s*=\s*\[[\s\S]*?\]\s*(?:\n|$)/m, "")
    content = `import { listProducts } from "@/lib/services/product.service"\n${content.trimStart()}`
    content = content.replace(
      /export\s+default\s+function\s+([A-Za-z0-9_]+)\s*\(\s*\)\s*\{/,
      "export default async function $1() {\n  const products = await listProducts()"
    )
    return { ...file, path, content }
  })
}

function buildCommercePrismaSchemaFile(): GeneratedFile {
  return {
    path: "prisma/schema.prisma",
    language: "prisma",
    content: `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String    @id @default(cuid())
  name      String
  email     String    @unique
  role      String    @default("buyer")
  products  Product[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Product {
  id          String   @id @default(cuid())
  name        String
  description String
  area        String   @default("Online")
  price       Int
  status      String   @default("draft")
  ownerId     String?
  owner       User?    @relation(fields: [ownerId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
`,
  }
}

function buildProductServiceFile(): GeneratedFile {
  return {
    path: "lib/services/product.service.ts",
    language: "ts",
    content: `import { z } from "zod"

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  area: z.string().min(1),
  price: z.number().int().nonnegative(),
  status: z.string().min(1),
})

export const CreateProductSchema = ProductSchema.omit({ id: true }).partial({
  description: true,
  area: true,
  status: true,
}).extend({
  name: z.string().min(1),
  price: z.number().int().nonnegative(),
})

export type Product = z.infer<typeof ProductSchema>
export type CreateProductInput = z.infer<typeof CreateProductSchema>

const productSeed: Product[] = [
  { id: "prod_1", name: "Starter Product", description: "Production-safe seed product served from the service layer.", area: "Online", price: 85000, status: "ready" },
  { id: "prod_2", name: "Featured Product", description: "Use Prisma-backed storage when DATABASE_URL is configured.", area: "Warehouse", price: 140000, status: "featured" },
]

export async function listProducts(): Promise<Product[]> {
  return productSeed
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  const parsed = CreateProductSchema.parse(input)
  return {
    id: \`prod_\${Date.now()}\`,
    description: parsed.description || "New product",
    area: parsed.area || "Online",
    status: parsed.status || "draft",
    ...parsed,
  }
}
`,
  }
}

function buildUserServiceFile(): GeneratedFile {
  return {
    path: "lib/services/user.service.ts",
    language: "ts",
    content: `import { z } from "zod"

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["admin", "seller", "buyer"]).default("buyer"),
})

export const CreateUserSchema = UserSchema.omit({ id: true })

export type PublicUser = z.infer<typeof UserSchema>
export type CreateUserInput = z.infer<typeof CreateUserSchema>

const userSeed: PublicUser[] = [
  { id: "user_admin", name: "Admin User", email: "admin@example.com", role: "admin" },
  { id: "user_seller", name: "Seller User", email: "seller@example.com", role: "seller" },
]

export async function listUsers(): Promise<PublicUser[]> {
  return userSeed
}

export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const parsed = CreateUserSchema.parse(input)
  return {
    id: \`user_\${Date.now()}\`,
    ...parsed,
  }
}
`,
  }
}

function buildProductsApiRouteFile(): GeneratedFile {
  return {
    path: "app/api/products/route.ts",
    language: "ts",
    content: `import { NextResponse } from "next/server"
import { CreateProductSchema, createProduct, listProducts } from "@/lib/services/product.service"

export async function GET() {
  const products = await listProducts()
  return NextResponse.json({ products, total: products.length })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const parsed = CreateProductSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid product payload", issues: parsed.error.flatten() }, { status: 400 })
  }

  const product = await createProduct(parsed.data)
  return NextResponse.json({ product }, { status: 201 })
}
`,
  }
}

function buildUsersApiRouteFile(): GeneratedFile {
  return {
    path: "app/api/users/route.ts",
    language: "ts",
    content: `import { NextResponse } from "next/server"
import { CreateUserSchema, createUser, listUsers } from "@/lib/services/user.service"

export async function GET() {
  const users = await listUsers()
  return NextResponse.json({ users, total: users.length })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const parsed = CreateUserSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid user payload", issues: parsed.error.flatten() }, { status: 400 })
  }

  const user = await createUser(parsed.data)
  return NextResponse.json({ user }, { status: 201 })
}
`,
  }
}

function extractPackageNames(files: GeneratedFile[]) {
  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  if (!packageFile) return []
  try {
    const parsed = JSON.parse(packageFile.content) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Array.from(new Set([
      ...Object.keys(parsed.dependencies || {}),
      ...Object.keys(parsed.devDependencies || {}),
    ])).sort()
  } catch {
    return []
  }
}

function buildAppPlan(input: { prompt: string; plan: GenerationPlan }) {
  const text = input.prompt.toLowerCase()
  const rolePatterns: Array<[string, RegExp]> = [
    ["admin", /\b(admin)\b/i],
    ["dokter", /\b(dokter|doctor)\b/i],
    ["pengelola", /\b(pengelola|staff)\b/i],
    ["user", /\b(user|pasien|patient)\b/i],
  ]
  const roles = rolePatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([role]) => role)
  const integrationPatterns: Array<[string, RegExp]> = [
    ["bpjs", /\bbpjs\b/i],
  ]
  const integrations = integrationPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([integration]) => integration)

  return {
    appType: input.plan.appType,
    objective: input.plan.objective,
    productionMode: input.plan.productionMode,
    structuredIntent: input.plan.structuredIntent,
    database: input.plan.productionMode === "production_fullstack",
    authentication: /\b(auth|login|register|role|rbac|admin|user|pengelola|dokter|pasien|patient)\b/i.test(text),
    api: input.plan.productionMode === "production_fullstack",
    roles: Array.from(new Set(roles)),
    integrations: Array.from(new Set([
      ...integrations,
      ...input.plan.structuredIntent.integrations.map((integration) => `${integration.kind}:${integration.provider}`),
    ])),
    architecture: input.plan.architecture,
    dependencyGraph: input.plan.dependencyGraph,
    fileCount: input.plan.filePlan.length,
    generatedFiles: input.plan.filePlan.map((file) => file.path),
  }
}

function summarizeGeneratedManifest(files: GeneratedFile[]) {
  return files.map((file) => normalizePath(file.path)).sort()
}

function summarizeContextFiles(files: GeneratedFile[]) {
  return files.map((file) => ({
    path: normalizePath(file.path),
    language: file.language || null,
    bytes: Buffer.byteLength(file.content || "", "utf8"),
  }))
}

function mergeFilesByPath(currentFiles: GeneratedFile[], nextFiles: GeneratedFile[]) {
  const byPath = new Map<string, GeneratedFile>()
  for (const file of currentFiles) {
    byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) })
  }
  for (const file of nextFiles) {
    byPath.set(normalizePath(file.path), { ...file, path: normalizePath(file.path) })
  }
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function hashGeneratedFiles(files: GeneratedFile[]) {
  const hash = createHash("sha256")
  for (const file of [...files].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path)))) {
    hash.update(normalizePath(file.path))
    hash.update("\0")
    hash.update(String(file.content || ""))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function validationErrorSignature(validation: ValidationLifecycleResult | null) {
  if (!validation?.failure) return ""
  return [
    validation.failure.step,
    String(validation.failure.message || "").replace(/\s+/g, " ").trim().slice(0, 500),
  ].join(":")
}

function commandOutputSignature(commands: Array<{ command: string; success: boolean; exitCode: number; stdout: string; stderr: string }>) {
  const hash = createHash("sha256")
  for (const command of commands) {
    hash.update(command.command)
    hash.update("\0")
    hash.update(command.success ? "1" : "0")
    hash.update("\0")
    hash.update(String(command.exitCode))
    hash.update("\0")
    hash.update(command.stdout || "")
    hash.update("\0")
    hash.update(command.stderr || "")
    hash.update("\0")
  }
  return hash.digest("hex")
}

function filterGeneratedFilesToTargets(files: GeneratedFile[], targetPaths: string[]) {
  const allowed = new Set(targetPaths.map(normalizePath))
  const acceptedFiles: GeneratedFile[] = []
  const rejectedFiles: GeneratedFile[] = []
  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (allowed.has(normalized)) {
      acceptedFiles.push({ ...file, path: normalized })
    } else {
      rejectedFiles.push({ ...file, path: normalized })
    }
  }
  return { acceptedFiles, rejectedFiles }
}

function scopeGeneratedArtifactToTargets(
  artifact: ReturnType<typeof parseGeneratedArtifact>,
  targetPaths: string[]
): ReturnType<typeof parseGeneratedArtifact> {
  const allowed = new Set(targetPaths.map(normalizePath))
  const files = artifact.files
    .filter((file) => allowed.has(normalizePath(file.path)))
    .map((file) => ({ ...file, path: normalizePath(file.path) }))

  if (!artifact.taskGraph) {
    return {
      ...artifact,
      files,
    }
  }

  const operations = artifact.taskGraph.operations
    .filter((operation) => allowed.has(normalizePath(operation.path)))
    .map((operation) => ({ ...operation, path: normalizePath(operation.path) }))

  return {
    ...artifact,
    files,
    taskGraph: {
      ...artifact.taskGraph,
      operations,
    },
  }
}

function findProductionMockArtifacts(files: GeneratedFile[]) {
  const bannedMockPattern = /\b(?:const|let|var)\s+[A-Za-z0-9_]*(?:dummy|mock|sample|placeholder|fake)[A-Za-z0-9_]*\s*=/i
  const suspiciousRecordPattern =
    /(?:id\s*:\s*["']?1["']?[\s\S]{0,240}(?:name|nama)\s*:)|(?:(?:name|nama)\s*:[\s\S]{0,240}id\s*:\s*["']?1["']?)/i

  return files
    .map((file) => ({
      path: normalizePath(file.path),
      content: String(file.content || ""),
    }))
    .filter((file) => /^(app\/(?:.+\/)?page\.(tsx|jsx|ts|js)|components\/.+\.(tsx|jsx|ts|js))$/i.test(file.path))
    .filter((file) => bannedMockPattern.test(file.content) || suspiciousRecordPattern.test(file.content))
    .map((file) => file.path)
    .slice(0, 12)
}

function parsePackageJsonFile(files: GeneratedFile[]) {
  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  if (!packageFile) {
    return {
      exists: false,
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: null as string | null,
    }
  }

  try {
    const parsed = JSON.parse(String(packageFile.content || "{}")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return {
      exists: true,
      dependencies: normalizePackageRecord(parsed.dependencies),
      devDependencies: normalizePackageRecord(parsed.devDependencies),
      parseError: null,
    }
  } catch (error) {
    return {
      exists: true,
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }
}

function normalizePackageRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name, version]) => name.trim() && typeof version === "string" && version.trim())
      .map(([name, version]) => [name.trim(), String(version).trim()])
  )
}

function assertDependenciesForBlueprint(files: GeneratedFile[], blueprint: ControlledAppBlueprint) {
  const packageJson = parsePackageJsonFile(files)
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const required = new Set<string>(["next", "react", "react-dom", "typescript"])

  if (paths.has("prisma/schema.prisma") || blueprint.requiredFiles.some((file) => normalizePath(file) === "prisma/schema.prisma")) {
    required.add("@prisma/client")
    required.add("prisma")
  }

  if (
    paths.has("app/api/auth/route.ts") ||
    blueprint.requiredFiles.some((file) => normalizePath(file) === "app/api/auth/route.ts")
  ) {
    required.add("next-auth")
  }

  if (Array.from(paths).some((path) => path.startsWith("app/api/")) || blueprint.requiredFiles.some((file) => normalizePath(file).startsWith("app/api/"))) {
    required.add("zod")
  }

  const missing = Array.from(required).filter((name) => !allDeps[name]).sort()
  return {
    ok: packageJson.exists && !packageJson.parseError && missing.length === 0,
    missing,
    parseError: packageJson.parseError,
    required: Array.from(required).sort(),
  }
}

function shouldRequireFullStackCoverage(plan: GenerationPlan) {
  if (plan.productionMode !== "production_fullstack") return false
  return ["fullstack_app", "architecture", "refactor", "runtime_debug"].includes(plan.objective)
}

function summarizeSandboxStep(step: SandboxValidationStep): ValidationLifecycleStepResult | null {
  if (step.name === "install" || step.name === "prisma-generate") {
    return {
      name: "dependency-install",
      status: step.status,
      policy: step.policy,
      durationMs: step.durationMs || 0,
      message: step.reason,
      data: {
        command: step.command || null,
        output: step.output || null,
        stdout: step.stdout || null,
        stderr: step.stderr || null,
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
      stdout: step.stdout || null,
      stderr: step.stderr || null,
    },
  }
}

function failureStepFromSandbox(validation: SandboxValidationStep[]): ValidationLifecycleStep {
  const failed = validation.find((step) => step.status === "failed" && step.policy === "required")
  if (failed?.name === "install" || failed?.name === "prisma-generate") {
    return "dependency-install"
  }
  if (failed?.name === "typecheck" || failed?.name === "lint" || failed?.name === "build") {
    return failed.name
  }

  return "runtime-smoke"
}

function validateRenderSafeGenerationRules(files: GeneratedFile[]) {
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const failures: string[] = []
  const rootLayout = files.find((file) => normalizePath(file.path) === "app/layout.tsx")
  const rootPage = files.find((file) => normalizePath(file.path) === "app/page.tsx")
  const providerFiles = files.filter((file) => /createContext|useContext|\.Provider|Provider\b/.test(file.content))

  if (!rootLayout) failures.push("app/layout.tsx is required for render-safe App Router output")
  if (!rootPage) failures.push("app/page.tsx is required for render-safe App Router output")
  if (rootLayout && !/<html[\s>]/.test(rootLayout.content)) failures.push("app/layout.tsx must render an html element")
  if (rootLayout && !/<body[\s>]/.test(rootLayout.content)) failures.push("app/layout.tsx must render a body element")

  for (const file of files.filter((item) => /\.(tsx|jsx)$/i.test(item.path))) {
    const normalized = normalizePath(file.path)
    const isClient = /"use client"|'use client'/.test(file.content)
    const needsClient = /\buse(State|Effect|Reducer|Ref|Context|Memo|Callback)\b|onClick=|onSubmit=|onChange=|createContext\(/.test(file.content)
    if (!isClient && needsClient) {
      failures.push(`${normalized} uses client-only React APIs without use client`)
    }
    if (isClient && /^app\/layout\.(tsx|jsx)$/i.test(normalized) && /export\s+const\s+metadata/.test(file.content)) {
      failures.push(`${normalized} mixes use client with server metadata export`)
    }
  }

  if (providerFiles.length > 0) {
    const providerPaths = providerFiles.map((file) => normalizePath(file.path))
    const wrapperUsed = files.some((file) =>
      /layout\.(tsx|jsx)$|page\.(tsx|jsx)$/i.test(normalizePath(file.path)) &&
      (providerPaths.some((providerPath) => file.content.includes(importStem(providerPath))) || /<[A-Z][A-Za-z0-9]*Provider\b/.test(file.content))
    )
    if (!wrapperUsed) {
      failures.push("context provider dependency detected but no Provider wrapper is injected into layout/page")
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    requiredFiles: {
      "app/layout.tsx": paths.has("app/layout.tsx"),
      "app/page.tsx": paths.has("app/page.tsx"),
    },
    providerFiles: providerFiles.map((file) => normalizePath(file.path)),
  }
}

function importStem(filePath: string) {
  const base = normalizePath(filePath).split("/").pop() || ""
  return base.replace(/\.(tsx|ts|jsx|js)$/i, "")
}

async function runValidationLifecycle(input: {
  jobId: string
  userId?: string
  projectId: string
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
  trace?: TraceIds
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
  await input.emit("validating", "Validating TSX and module syntax", 60)
  let tsxValidation = validateRuntimeSyntax(files)
  let tsxRepair = null as ReturnType<typeof autoRepairAdjacentJsxFragments> | null
  if (!tsxValidation.ok) {
    tsxRepair = autoRepairAdjacentJsxFragments(files, tsxValidation.diagnostics[0])
    if (tsxRepair.repaired) {
      files = tsxRepair.files
      tsxValidation = validateRuntimeSyntax(files)
    }
  }
  if (!tsxValidation.ok) {
    const first = tsxValidation.diagnostics[0]
    const message = first
      ? `${first.file}${first.line ? ` Line ${first.line}, Column ${first.column ?? 0}` : ""}: ${first.message}`
      : "TSX validation failed"
    recordStep("tsx-validation", "failed", "required", stepStartedAt, message, {
      diagnostics: tsxValidation.diagnostics,
      repairPayload: first
        ? {
            mode: "syntax_repair",
            targetFile: first.file,
            error: first.message,
            line: first.line,
            column: first.column,
          }
        : null,
      repairStrategy: first?.repairStrategy || "targeted_syntax_repair",
      autoRepairAttempted: Boolean(tsxRepair),
      autoRepairChangedFiles: tsxRepair?.changedFiles.map((file) => normalizePath(file.path)) || [],
      repairedNodeType: tsxRepair?.repairedNodeType || null,
      repairSuccess: false,
    })
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: "tsx_validation_failed",
      steps,
      sandboxValidation: [],
      failure: {
        step: "tsx-validation",
        message,
        data: {
          diagnostics: tsxValidation.diagnostics,
          repairStrategy: first?.repairStrategy || "targeted_syntax_repair",
          targetFile: first?.file || null,
          repairedNodeType: tsxRepair?.repairedNodeType || null,
          repairSuccess: false,
        },
      },
    }
  }
  recordStep("tsx-validation", "passed", "required", stepStartedAt, tsxRepair?.repaired ? "Auto fragment repair applied" : undefined, {
    diagnostics: tsxValidation.diagnostics,
    repairStrategy: tsxRepair?.strategy || null,
    changedFiles: tsxRepair?.changedFiles.map((file) => normalizePath(file.path)) || [],
    repairedNodeType: tsxRepair?.repairedNodeType || null,
    repairSuccess: tsxRepair?.repaired || false,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Normalizing generated artifacts", 63)
  const normalized = normalizeGeneratedDependencies(files)
  files = ensureComponentRegistryFiles(normalized.files)
  const renderSafeRules = validateRenderSafeGenerationRules(files)
  if (!renderSafeRules.ok) {
    const message = `Render-safe generation rules failed: ${renderSafeRules.failures.join("; ")}`
    recordStep("normalize", "failed", "required", stepStartedAt, message, {
      renderSafeRules,
    })
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: "render_safe_rules_failed",
      steps,
      sandboxValidation: [],
      failure: {
        step: "normalize",
        message,
        data: {
          renderSafeRules,
        },
      },
    }
  }
  recordStep("normalize", "passed", "required", stepStartedAt, undefined, {
    fileCount: files.length,
    addedPackages: normalized.addedPackages,
    normalizedPackages: normalized.normalizedPackages,
    conflictsPrevented: normalized.conflictsPrevented,
    renderSafeRules,
  })

  const plannedPaths = input.plan.filePlan.map((file) => normalizePath(file.path))
  const shouldAutoRepairImports =
    input.plan.productionMode === "full_frontend" ||
    input.plan.productionMode === "production_fullstack" ||
    input.plan.generationMode === "REBUILD"
  const importRepair = repairRuntimeImportGraph(files, {
    plannedPaths,
    createMissing: shouldAutoRepairImports,
  })
  if (importRepair.changedFiles.length > 0 || importRepair.diagnostics.length > 0 || importRepair.deferredMissing.length > 0) {
    files = importRepair.files
    if (importRepair.changedFiles.length > 0) {
      files = normalizeGeneratedDependencies(files).files
    }
    recordStep(
      "import-validation",
      importRepair.diagnostics.length > 0 ? "failed" : "passed",
      importRepair.diagnostics.length > 0 ? "required" : "advisory",
      performance.now(),
      importRepair.diagnostics.length > 0 ? importRepair.diagnostics.join("; ") : "Auto-repaired generated import graph",
      {
        autoRepair: true,
        changedFiles: importRepair.changedFiles.map((file) => normalizePath(file.path)),
        createdFiles: importRepair.createdFiles.map((file) => normalizePath(file.path)),
        rewrites: importRepair.rewrites,
        deferredMissing: importRepair.deferredMissing,
        diagnostics: importRepair.diagnostics,
      }
    )
    if (importRepair.diagnostics.length > 0) {
      return {
        ok: false,
        files,
        previewUrl: null,
        previewStatus: "import_validation_failed",
        steps,
        sandboxValidation: [],
        failure: {
          step: "import-validation",
          message: importRepair.diagnostics.join("; "),
          data: {
            autoRepair: true,
            diagnostics: importRepair.diagnostics,
            rewrites: importRepair.rewrites,
            createdFiles: importRepair.createdFiles.map((file) => normalizePath(file.path)),
          },
        },
      }
    }
  }

  if (input.plan.generationMode === "PATCH") {
    await GenerationJobService.assertNotCancelled(input.jobId)
    stepStartedAt = performance.now()
    await input.emit("validating", "Running scoped edit validation", 70, {
      generationMode: input.plan.generationMode,
      editIntent: input.plan.incrementalEdit.editIntent,
      affectedFiles: input.plan.incrementalEdit.affectedFiles,
    })
    const changedFiles = files.filter((file) => input.plan.incrementalEdit.affectedFiles.includes(normalizePath(file.path)))
    const scopedValidation = validateIncrementalPatch({
      files,
      changedFiles,
      plan: input.plan.incrementalEdit,
    })
    recordStep(
      "static",
      scopedValidation.ok ? "passed" : "failed",
      "required",
      stepStartedAt,
      scopedValidation.ok ? "Scoped edit validation passed" : "Scoped edit validation failed",
      {
        generationMode: input.plan.generationMode,
        editIntent: input.plan.incrementalEdit.editIntent,
        scopedValidation,
        skippedGlobalValidation: true,
        skippedBlueprintValidation: true,
        skippedArchitectureValidation: true,
      }
    )
    return {
      ok: scopedValidation.ok,
      files,
      previewUrl: null,
      previewStatus: scopedValidation.ok ? "preserved" : "scoped_validation_failed",
      steps,
      sandboxValidation: [],
      failure: scopedValidation.ok
        ? undefined
        : {
            step: "static",
            message: scopedValidation.diagnostics.map((diagnostic) => diagnostic.reason).join("; ") || "Scoped edit validation failed",
            data: {
              scopedValidation,
              skippedGlobalValidation: true,
            },
          },
    }
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Validating runtime imports", 66)
  const fullstack = validateFullStackFiles(files)
  const dependencyMap = buildDependencyMap(files)
  const importValidation = validateRuntimeImports(files, {
    plannedPaths,
    requireTsconfigAlias: input.plan.productionMode === "production_fullstack",
  })
  if (!importValidation.ok) {
    const first = importValidation.diagnostics[0]
    const message = first
      ? `${first.file}${first.line ? ` Line ${first.line}, Column ${first.column ?? 0}` : ""}: ${first.message}`
      : "Import validation failed"
    recordStep("import-validation", "failed", "required", stepStartedAt, message, {
      diagnostics: importValidation.diagnostics,
      missingLocalImports: dependencyMap.missingLocalImports.slice(0, 12),
      unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
    })
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: "import_validation_failed",
      steps,
      sandboxValidation: [],
      failure: {
        step: "import-validation",
        message,
        data: {
          diagnostics: importValidation.diagnostics,
          missingLocalImports: dependencyMap.missingLocalImports.slice(0, 12),
          unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
        },
      },
    }
  }
  recordStep("import-validation", "passed", "required", stepStartedAt, undefined, {
    diagnostics: [],
    localImportCount: dependencyMap.localImports.length,
    externalPackages: dependencyMap.externalPackages,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Validating component registry contracts", 67)
  const selectedTemplate = selectIntentTemplate(input.prompt)
  const componentContracts = validateComponentContracts(files, {
    selectedTemplate: selectedTemplate?.id || null,
  })
  log("info", "component_registry_usage", {
    jobId: input.jobId,
    projectId: input.projectId,
    ...componentContracts.usage,
  })
  await GenerationJobService.appendEvent({
    jobId: input.jobId,
    type: "component_registry_usage",
    stage: "validating",
    status: componentContracts.ok ? "completed" : "failed",
    message: "Component registry usage analyzed",
    data: componentContracts.usage,
  }).catch(() => null)
  if (!componentContracts.ok) {
    const message = `Component contract validation failed: ${componentContracts.failures.map((failure) => `${failure.file}: ${failure.message}`).slice(0, 8).join("; ")}`
    recordStep("component-contracts", "failed", "required", stepStartedAt, message, {
      componentContracts,
      dependencyGraph: componentContracts.dependencyGraph,
    })
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: "component_contract_failed",
      steps,
      sandboxValidation: [],
      failure: {
        step: "component-contracts",
        message,
        data: {
          componentContracts,
          dependencyGraph: componentContracts.dependencyGraph,
        },
      },
    }
  }
  recordStep("component-contracts", "passed", "required", stepStartedAt, undefined, {
    componentContracts,
    dependencyGraph: componentContracts.dependencyGraph,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  await input.emit("validating", "Checking static project invariants", 68)
  const plannedRequiredFiles = input.plan.filePlan.map((file) => normalizePath(file.path))
  const productionRequiredFilesForValidation =
    input.plan.productionMode === "production_fullstack"
      ? plannedRequiredFiles
      : input.plan.productionMode === "full_frontend"
        ? plannedRequiredFiles
      : input.plan.blueprint.requiredFiles
  const isPreviewFoundationPass =
    input.plan.productionMode === "preview" &&
    input.plan.editPlan.mode === "full" &&
    plannedRequiredFiles.length <= PREVIEW_FOUNDATION_FILE_LIMIT
  const partialRequiredFiles =
    isPreviewFoundationPass
      ? plannedRequiredFiles
      : input.plan.editPlan.mode === "partial"
      ? input.plan.blueprint.requiredFiles.filter((filePath) => {
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
      : productionRequiredFilesForValidation
  const blueprintValidation = validateBlueprintConstraints(files, input.blueprint, {
    requiredFiles: partialRequiredFiles,
  })
  const dependencyContract = input.plan.productionMode === "production_fullstack"
    ? assertDependenciesForBlueprint(files, input.blueprint)
    : { ok: true, missing: [] as string[], parseError: null as string | null, required: [] as string[] }
  const currentMemory = buildProjectMemoryGraph({
    files,
    intent: input.plan.structuredIntent,
    architecturePlan: input.plan.architecture,
  })
  const currentDependencyGraph = buildArchitectureDependencyGraph({
    intent: input.plan.structuredIntent,
    architecturePlan: input.plan.architecture,
    memory: currentMemory,
  })
  const architectureValidation = input.plan.productionMode === "production_fullstack"
    ? validateArchitectureFiles({
        files,
        architecturePlan: input.plan.architecture,
        dependencyGraph: currentDependencyGraph,
      })
    : { ok: true, diagnostics: [] as ReturnType<typeof validateArchitectureFiles>["diagnostics"] }
  const staticFailures: string[] = []
  const requiresFullStackCoverage = !isPreviewFoundationPass && shouldRequireFullStackCoverage(input.plan)

  if (requiresFullStackCoverage && fullstack.missingCategories.length > 0) {
    staticFailures.push(`Missing required full-stack categories: ${fullstack.missingCategories.join(", ")}`)
  }

  const mockArtifacts = input.plan.productionMode === "production_fullstack"
    ? findProductionMockArtifacts(files)
    : []
  if (mockArtifacts.length > 0) {
    staticFailures.push(`Production full-stack files contain UI-level mock data: ${mockArtifacts.join(", ")}`)
  }
  const frontendCompleteness =
    input.plan.productionMode === "full_frontend"
      ? validateFrontendCompleteness(files)
      : null
  if (frontendCompleteness && !frontendCompleteness.ok) {
    staticFailures.push(`Frontend completeness failed: ${frontendCompleteness.failures.join("; ")}`)
  }

  if (!blueprintValidation.ok) {
    if (blueprintValidation.missingRequiredFiles.length > 0) {
      staticFailures.push(`Missing blueprint files: ${blueprintValidation.missingRequiredFiles.join(", ")}`)
    }
    if (blueprintValidation.forbiddenFiles.length > 0) {
      staticFailures.push(`Forbidden stack drift files: ${blueprintValidation.forbiddenFiles.join(", ")}`)
    }
  }

  if (!dependencyContract.ok) {
    if (dependencyContract.parseError) {
      staticFailures.push(`package.json parse error: ${dependencyContract.parseError}`)
    }
    if (dependencyContract.missing.length > 0) {
      staticFailures.push(`Missing blueprint dependencies: ${dependencyContract.missing.join(", ")}`)
    }
  }

  if (!architectureValidation.ok) {
    staticFailures.push(
      `Architecture validation failed: ${architectureValidation.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message)
        .slice(0, 8)
        .join("; ")}`
    )
  }

  if (staticFailures.length > 0) {
    const message = staticFailures.join("; ")
    const data = {
      appType: input.plan.appType,
      receivedFiles: filePathList(files),
      receivedFileCount: files.length,
      coverage: fullstack.coverage,
      missingCategories: fullstack.missingCategories,
      fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
      blueprint: {
        missingRequiredFiles: blueprintValidation.missingRequiredFiles,
        forbiddenFiles: blueprintValidation.forbiddenFiles,
      },
      dependencies: dependencyContract,
      architectureValidation,
      projectMemory: currentMemory,
      dependencyGraph: currentDependencyGraph,
      mockArtifacts,
      frontendCompleteness,
      missingLocalImports: dependencyMap.missingLocalImports.slice(0, 12),
      unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
    }
    log("warn", "project_validator_failed", {
      jobId: input.jobId,
      projectId: input.projectId,
      receivedFileCount: files.length,
      receivedFiles: filePathList(files),
      missingRequiredFiles: blueprintValidation.missingRequiredFiles,
      forbiddenFiles: blueprintValidation.forbiddenFiles,
      missingCategories: fullstack.missingCategories,
      reasons: staticFailures,
    })
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
    receivedFiles: filePathList(files),
    coverage: fullstack.coverage,
    missingCategories: fullstack.missingCategories,
    fullStackCoveragePolicy: requiresFullStackCoverage ? "required" : "advisory",
    blueprintRequiredFiles: input.plan.blueprint.requiredFiles.length,
    requiredFilesMissing: blueprintValidation.missingRequiredFiles,
    dependencies: dependencyContract,
    architectureValidation,
    projectMemory: currentMemory,
    dependencyGraph: currentDependencyGraph,
    mockArtifacts,
    frontendCompleteness,
    localImportCount: dependencyMap.localImports.length,
    externalPackages: dependencyMap.externalPackages,
  })
  log("info", "project_validator_passed", {
    jobId: input.jobId,
    projectId: input.projectId,
    receivedFileCount: files.length,
    receivedFiles: filePathList(files),
    requiredFilesMissing: blueprintValidation.missingRequiredFiles,
  })

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  if (input.plan.productionMode === "production_fullstack") {
    await input.emit("validating", "Skipping browser-only preview compile for full-stack runtime build", 74)
    recordStep(
      "preview-compile",
      "skipped",
      "advisory",
      stepStartedAt,
      "Production full-stack apps are validated by sandbox install, build, and runtime smoke gates.",
      {
        unsupportedPreviewImports: dependencyMap.unsupportedPreviewImports.slice(0, 12),
      }
    )
  } else {
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
  }

  await GenerationJobService.assertNotCancelled(input.jobId)
  stepStartedAt = performance.now()
  if (canUseRemoteSandboxService()) {
    await input.emit("building", "Validating project in configured sandbox service", 84)
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "preview_started",
      stage: "building",
      status: "running",
      message: "Remote sandbox boot started",
      data: {
        sandbox: "remote",
        buildStarted: true,
      },
    })
    await OrchestrationRuntimeService.upsertPreviewSession({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      status: "starting",
      idempotencyKey: `preview:${input.jobId}:remote`,
      mark: "boot",
      diagnostics: { sandbox: "remote" },
    }).catch(() => null)
    const preview = await startConfiguredSandboxService({
      projectId: input.projectId,
      files,
      signal: input.signal,
    })
    const logs = Array.isArray(preview.logs) ? preview.logs : []
    if (preview.error || preview.status !== "running") {
      const message = preview.error || `Sandbox service did not reach running state (${preview.status || "unknown"})`
      recordStep("runtime-smoke", "failed", "required", stepStartedAt, message, {
        sandboxStatus: preview.status || null,
        logs: logs.slice(-80),
      })
      await appendOrchestrationEvent({
        jobId: input.jobId,
        trace: input.trace,
        type: "preview_failed",
        stage: "building",
        status: "failed",
        message,
        data: {
          sandbox: "remote",
          sandboxStatus: preview.status || null,
          previewUrl: preview.previewUrl || null,
          logs: logs.slice(-20),
        },
      })
      await OrchestrationRuntimeService.upsertPreviewSession({
        jobId: input.jobId,
        projectId: input.projectId,
        trace: input.trace,
        status: "failed",
        previewUrl: preview.previewUrl || null,
        terminationReason: message,
        idempotencyKey: `preview:${input.jobId}:remote`,
        mark: "terminated",
        diagnostics: {
          sandbox: "remote",
          sandboxStatus: preview.status || null,
          logs: logs.slice(-20),
        },
      }).catch(() => null)
      await captureValidationRuntimeFailure({
        jobId: input.jobId,
        projectId: input.projectId,
        trace: input.trace,
        files,
        message,
        source: "sandbox",
        metadata: {
          sandbox: "remote",
          sandboxStatus: preview.status || null,
          previewUrl: preview.previewUrl || null,
          logs: logs.slice(-20),
        },
      })
      return {
        ok: false,
        files,
        previewUrl: preview.previewUrl || null,
        previewStatus: preview.status || null,
        steps,
        sandboxValidation: [],
        failure: {
          step: "runtime-smoke",
          message,
          data: {
            sandboxStatus: preview.status || null,
            logs: logs.slice(-80),
          },
        },
      }
    }

    recordStep("typecheck", "passed", "required", stepStartedAt, "Sandbox service accepted the project typecheck/build gate.", {
      sandboxStatus: preview.status,
      logs: logs.slice(-20),
    })
    recordStep("build", "passed", "required", stepStartedAt, "Sandbox service accepted and built the project.", {
      sandboxStatus: preview.status,
      logs: logs.slice(-20),
    })
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "preview_ready",
      stage: "building",
      status: "running",
      message: "Remote sandbox preview reachable",
      data: {
        sandbox: "remote",
        sandboxStatus: preview.status,
        previewUrl: preview.previewUrl || null,
        buildCompleted: true,
      },
    })
    await OrchestrationRuntimeService.upsertPreviewSession({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      status: "ready",
      previewUrl: preview.previewUrl || null,
      idempotencyKey: `preview:${input.jobId}:remote`,
      mark: "reachable",
      diagnostics: {
        sandbox: "remote",
        sandboxStatus: preview.status,
        logs: logs.slice(-20),
      },
    }).catch(() => null)
    recordStep("runtime-smoke", "passed", "required", stepStartedAt, undefined, {
      sandboxStatus: preview.status,
      previewUrl: preview.previewUrl || null,
    })

    return {
      ok: true,
      files,
      previewUrl: preview.previewUrl || null,
      previewStatus: preview.status || null,
      steps,
      sandboxValidation: [],
    }
  }

  if (
    isProductionVercel() &&
    input.plan.productionMode === "production_fullstack" &&
    process.env.SWIFT_REQUIRE_SANDBOX_FOR_PRODUCTION_FULLSTACK === "true"
  ) {
    const message = "Production full-stack generation requires SANDBOX_SERVICE_URL so generated artifacts can pass install, build, and runtime smoke before persistence."
    await input.emit("building", "Runtime sandbox required for production full-stack artifacts", 84)
    recordStep("build", "failed", "required", stepStartedAt, message)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "build",
        message,
      },
    }
  }

  if (isProductionVercel()) {
    const message = "Compile gate requires SANDBOX_SERVICE_URL/SANDBOX_SERVICE_TOKEN so typecheck, build, and runtime smoke pass before persistence."
    await input.emit("building", "Runtime sandbox required before persistence", 84)
    recordStep("build", "failed", "required", stepStartedAt, message)
    recordStep("runtime-smoke", "failed", "required", stepStartedAt, message)
    return {
      ok: false,
      files,
      previewUrl: null,
      previewStatus: null,
      steps,
      sandboxValidation: [],
      failure: {
        step: "build",
        message,
      },
    }
  }

  await input.emit("building", "Running typecheck, lint, and production build", 84)
  await appendOrchestrationEvent({
    jobId: input.jobId,
    trace: input.trace,
    type: "preview_started",
    stage: "building",
    status: "running",
    message: "Runtime sandbox boot started",
    data: {
      sandbox: "local",
      buildStarted: true,
      devServerStartup: "pending",
    },
  })
  await OrchestrationRuntimeService.upsertPreviewSession({
    jobId: input.jobId,
    projectId: input.projectId,
    trace: input.trace,
    status: "starting",
    idempotencyKey: `preview:${input.jobId}:local`,
    mark: "boot",
    diagnostics: { sandbox: "local" },
  }).catch(() => null)
  const preview = input.userId
    ? await runDedicatedUserSandbox({
        userId: input.userId,
        projectId: input.projectId,
        files,
        signal: input.signal,
      })
    : await startRuntimeSandbox(input.projectId, files, { signal: input.signal })
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
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "preview_failed",
      stage: "building",
      status: "failed",
      message: preview.error,
      data: {
        sandbox: "local",
        sandboxStatus: preview.status,
        previewUrl: preview.previewUrl,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-20),
        previewTimeout: /timeout|timed out/i.test(preview.error),
      },
    })
    await OrchestrationRuntimeService.upsertPreviewSession({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      status: "failed",
      previewUrl: preview.previewUrl,
      terminationReason: preview.error,
      idempotencyKey: `preview:${input.jobId}:local`,
      mark: "terminated",
      diagnostics: {
        sandbox: "local",
        sandboxStatus: preview.status,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-20),
      },
    }).catch(() => null)
    await captureValidationRuntimeFailure({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      files,
      message: preview.error,
      source: "sandbox",
      metadata: {
        sandbox: "local",
        sandboxStatus: preview.status,
        previewUrl: preview.previewUrl,
        runtimeVerification: runtimeFailed,
        logs: preview.logs.slice(-20),
      },
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
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: input.trace,
      type: "preview_failed",
      stage: "building",
      status: "failed",
      message,
      data: {
        sandbox: "local",
        sandboxStatus: preview.status,
        previewUrl: preview.previewUrl,
        sandboxValidation: preview.validation,
      },
    })
    await OrchestrationRuntimeService.upsertPreviewSession({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      status: "failed",
      previewUrl: preview.previewUrl,
      terminationReason: message,
      idempotencyKey: `preview:${input.jobId}:local`,
      mark: "terminated",
      diagnostics: {
        sandbox: "local",
        sandboxStatus: preview.status,
        sandboxValidation: preview.validation,
      },
    }).catch(() => null)
    await captureValidationRuntimeFailure({
      jobId: input.jobId,
      projectId: input.projectId,
      trace: input.trace,
      files,
      message,
      source: "sandbox",
      metadata: {
        sandbox: "local",
        sandboxStatus: preview.status,
        previewUrl: preview.previewUrl,
        sandboxValidation: preview.validation,
      },
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
  await appendOrchestrationEvent({
    jobId: input.jobId,
    trace: input.trace,
    type: "preview_ready",
    stage: "building",
    status: "running",
    message: "Runtime sandbox preview reachable",
    data: {
      sandbox: "local",
      sandboxStatus: preview.status,
      previewUrl: preview.previewUrl,
      buildCompleted: true,
      devServerStartup: "completed",
      runtimeVerification: preview.runtimeVerification,
    },
  })
  await OrchestrationRuntimeService.upsertPreviewSession({
    jobId: input.jobId,
    projectId: input.projectId,
    trace: input.trace,
    status: "ready",
    previewUrl: preview.previewUrl,
    idempotencyKey: `preview:${input.jobId}:local`,
    mark: "reachable",
    diagnostics: {
      sandbox: "local",
      sandboxStatus: preview.status,
      runtimeVerification: preview.runtimeVerification,
    },
  }).catch(() => null)

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
  projectId: string
  prompt: string
  files: GeneratedFile[]
  plan: GenerationPlan
  blueprint: ControlledAppBlueprint
  editPlan: PartialEditPlan
  validationError: string
  repairAttempt: number
  maxRepairAttempts: number
  promptLanguage: "id" | "en"
  observation?: AgentWorkflowObservation
  signal?: AbortSignal
}) {
  await GenerationJobService.assertNotCancelled(input.jobId)
  if (input.plan.generationMode === "PATCH") {
    const scopedPayload = parseRepairPayload({
      mode: "scoped",
      affectedFiles: input.plan.incrementalEdit.affectedFiles,
      operations: [],
    })
    return {
      files: input.files,
      repaired: false,
      parsedFileCount: 0,
      acceptedFileCount: 0,
      rejectedFiles: [],
      deletedPaths: [],
      installedDependencies: [],
      normalizedPackages: [],
      addedPackages: [],
      repairPromptPreview: "",
      repairedArtifactSummary: {
        mode: "scoped",
        scopedPayload,
        skippedArchitectureRepair: true,
      },
      terminationReason: "empty_repair_output" as RepairTerminationReason,
      failureMessage: "EDIT mode only permits scoped repair; architecture repair was skipped.",
    }
  }
  const currentFiles = [...input.files]
  const dependencyMap = buildDependencyMap(currentFiles)
  const failingFiles = pickFailingFiles(currentFiles, dependencyMap, input.validationError)
  const syntaxRepairOnly = /tsx[-_ ]validation|Adjacent JSX|Missing closing tag|Unexpected token|Invalid import syntax|Duplicate export/i.test(input.validationError)
  const minimalRepairOnly = syntaxRepairOnly
  const failingPathSet = new Set(failingFiles.map((file) => normalizePath(file.path)))
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
    buildArchitectureInstructionBlock(input.plan.architecture),
    "",
    buildRoleInstructionBlock({
      diagnostics: input.plan.orchestration,
      role: "repair",
    }),
    "",
    buildPartialEditInstructionBlock(input.editPlan),
    "",
    "DETERMINISTIC_VALIDATION_FAILURE:",
    input.validationError,
    "",
    "TARGETED_REPAIR_ONLY:",
    `- MAX_FILES_PER_REPAIR: ${MAX_FILES_PER_REPAIR}. Repair only the failing file, its imported dependency, or the nearest dependency graph neighbor.`,
    "- APPROVED_SCOPE_ONLY: repair output may include only exact paths listed in APPROVED_FILE_SCOPE_CONTRACT.allowedPaths.",
    "- HELPER_FILE_POLICY: do not create components/app-shell.tsx, components/*-shell.tsx, or components/*helper*.tsx unless that exact path is explicitly listed in APPROVED_FILE_SCOPE_CONTRACT.allowedPaths.",
    syntaxRepairOnly
      ? `- SYNTAX_REPAIR_MODE: return changes only for these failing file paths: ${Array.from(failingPathSet).join(", ")}. Do not touch imports unless the syntax diagnostic explicitly names an import statement.`
      : minimalRepairOnly
        ? `- MINIMAL_FIX_MODE: return changes only for these failing file paths: ${Array.from(failingPathSet).join(", ")}. Do not create files, add features, or expand architecture.`
        : "- Business or architecture repair may add direct missing dependencies only when validation requires them.",
    "- Do not regenerate the entire project.",
    "- Return only changed files.",
    "- Never create or modify next-auth.d.ts, root auth.ts, or any .env file during repair; use app/ route handlers or lib/ helpers for NextAuth changes.",
    "- PATH POLICY: every path must normalize and resolve inside the workspace, and must start with src/, app/, components/, lib/, prisma/, or an allowlisted root file such as package.json, tsconfig.json, next.config.ts, tailwind.config.ts, postcss.config.js, README.md, or .env.example.",
    "- BLOCKED PATHS: never use .., ~, absolute paths, node_modules, .env files, .git, package-lock.json, pnpm-lock.yaml, or yarn.lock.",
    '- Return ONLY strict JSON matching this repair schema: {"files":[{"path":"app/page.tsx","content":"complete replacement content","language":"tsx"}],"dependencies":[],"commands":[],"summary":"short repair summary","diagnostics":[],"metadata":{}}.',
    "- files must be a non-empty array when a repair is possible. Do not return diagnostics-only, prose, Markdown, or partial snippets.",
    "- commands must always be []. taskGraph is allowed only when every create/modify operation has full content.",
    "- The repaired file must be syntactically valid TSX/TypeScript. No raw emoji, no unterminated strings, no split quoted strings.",
    "- If a fancy design is causing syntax risk, replace it with a minimal compile-safe version of the failing file.",
    "- The result will be revalidated through normalize -> static validation -> preview compile -> typecheck -> lint -> build before persistence.",
    `- Repair attempt: ${input.repairAttempt} / ${input.maxRepairAttempts}`,
    "",
    "APPROVED_FILE_SCOPE_CONTRACT:",
    JSON.stringify(input.plan.allowedFileScope, null, 2),
    "",
    "FAILING_FILES_CONTEXT:",
    failingFiles.map((file) => `FILE ${file.path}\n${file.content}`).join("\n\n"),
    "",
    "AGENT_WORKFLOW_CONTEXT:",
    JSON.stringify(
      {
        observation: input.observation ? summarizeAgentObservation(input.observation) : null,
        incrementalEdit: input.plan.incrementalEdit,
        architecturePlan: input.plan.architecture,
        projectMemory: input.plan.projectMemory,
        dependencyGraph: input.plan.dependencyGraph,
        missingBusinessDependencies: input.plan.dependencyGraph.missingBusinessDependencies,
        previousAttempts: input.observation?.previousAttempts || [],
      },
      null,
      2
    ),
  ].join("\n")

  const response = await runProviderAttempt({
    jobId: input.jobId,
    projectId: input.projectId,
    prompt: repairPrompt,
    purpose: "repair",
    orchestrationRole: "repair",
    logicalModel: input.plan.orchestration.repairModel,
    selectedModel: "repair",
    promptLanguage: input.promptLanguage,
    signal: input.signal,
  })
  log("info", "repair_payload_received", {
    jobId: input.jobId,
    projectId: input.projectId,
    repairAttempt: input.repairAttempt,
    maxRepairAttempts: input.maxRepairAttempts,
    rawLength: response.message.length,
    rawHash: hashText(response.message),
    RAW_REPAIR_PAYLOAD: runtimeLogText(response.message),
  })
  let parsed: ReturnType<typeof parseGeneratedArtifact>
  try {
    parsed = parseGeneratedArtifact(response.message)
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error)
    log("warn", "repair_payload_schema_validation_failed", {
      jobId: input.jobId,
      projectId: input.projectId,
      repairAttempt: input.repairAttempt,
      maxRepairAttempts: input.maxRepairAttempts,
      failure: failureMessage,
      rawHash: hashText(response.message),
      RAW_REPAIR_PAYLOAD: runtimeLogText(response.message),
    })
    return {
      files: currentFiles,
      repaired: false,
      parsedFileCount: 0,
      acceptedFileCount: 0,
      rejectedFiles: [],
      deletedPaths: [],
      installedDependencies: [],
      normalizedPackages: [],
      addedPackages: [],
      repairPromptPreview: repairPrompt.slice(0, 6000),
      repairedArtifactSummary: summarizeArtifactPayload({ files: [] }),
      terminationReason: "malformed_repair_payload" as RepairTerminationReason,
      failureMessage,
    }
  }
  log("info", "repair_payload_schema_validation_passed", {
    jobId: input.jobId,
    projectId: input.projectId,
    repairAttempt: input.repairAttempt,
    parsedFileCount: parsed.files.length,
    parsedFiles: filePathList(parsed.files),
    taskOperationCount: parsed.taskGraph?.operations.length || 0,
  })
  const parsedFileCount = parsed.files.length
  const allowedScopeResult = scopeArtifactToAllowedScope(parsed, input.plan)
  parsed = allowedScopeResult.artifact
  const repairScopePathSet = new Set(failingFiles.map((file) => normalizePath(file.path)))
  parsed = {
    ...parsed,
    files: parsed.files.filter((file) => repairScopePathSet.has(normalizePath(file.path))).slice(0, MAX_FILES_PER_REPAIR),
    taskGraph: parsed.taskGraph
      ? {
          ...parsed.taskGraph,
          operations: parsed.taskGraph.operations
            .filter((operation) => repairScopePathSet.has(normalizePath(operation.path)))
            .slice(0, MAX_FILES_PER_REPAIR),
        }
      : undefined,
  }
  const scoped = minimalRepairOnly
    ? {
        acceptedFiles: parsed.files.filter((file) => failingPathSet.has(normalizePath(file.path))),
        rejectedFiles: parsed.files.filter((file) => !failingPathSet.has(normalizePath(file.path))),
      }
    : parsed.taskGraph
      ? { acceptedFiles: parsed.files, rejectedFiles: [] as GeneratedFile[] }
      : filterFilesForPartialEdit(parsed.files, input.editPlan)
  const executed = executeGeneratedTaskGraph(currentFiles, parsed.taskGraph, scoped.acceptedFiles, parsed.dependencies)
  const mergedFiles = executed.files
  const normalized = normalizeGeneratedDependencies(mergedFiles)

  return {
    files: normalized.files,
    repaired: scoped.acceptedFiles.length > 0,
    parsedFileCount,
    acceptedFileCount: scoped.acceptedFiles.length,
    rejectedFiles: [
      ...allowedScopeResult.rejected.map((item) => `${item.path}: ${item.reason}`),
      ...scoped.rejectedFiles.map((file) => `${file.path}: outside repair target scope`),
    ].slice(0, 8),
    deletedPaths: executed.deletedPaths,
    installedDependencies: executed.installedDependencies,
    normalizedPackages: normalized.normalizedPackages,
    addedPackages: normalized.addedPackages,
    repairPromptPreview: repairPrompt.slice(0, 6000),
    repairedArtifactSummary: summarizeArtifactPayload({
      files: parsed.files,
      dependencies: parsed.dependencies,
      operations: parsed.taskGraph?.operations,
    }),
    terminationReason: scoped.acceptedFiles.length > 0 ? null : "empty_repair_output" as RepairTerminationReason,
    failureMessage: scoped.acceptedFiles.length > 0
      ? null
      : allowedScopeResult.rejected.length > 0
        ? `Repair output contained only files outside allowed scope: ${allowedScopeResult.rejected.map((item) => `${item.path} (${item.reason})`).join("; ")}`
        : "Repair output contained no accepted file changes",
  }
}

function shouldApplySafePreviewFallback(plan: GenerationPlan, validation: ValidationLifecycleResult) {
  const isPreviewFoundationPass =
    plan.productionMode === "preview" &&
    plan.editPlan.mode === "full" &&
    plan.filePlan.length > 0 &&
    plan.filePlan.length <= PREVIEW_FOUNDATION_FILE_LIMIT
  if (!isPreviewFoundationPass) return false

  const failureMessage = validation.failure?.message || ""
  return validation.failure?.step === "preview-compile" || /unterminated|unexpected character|parse/i.test(failureMessage)
}

// Legacy broad fallback generation is intentionally unreachable under the
// role-based repair policy. Keep the historical helper inert until it can be
// removed in a dedicated cleanup without obscuring this policy change.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildSafePreviewFallbackFiles(input: {
  prompt: string
  appType: ControlledAppType
}): GeneratedFile[] {
  const lowerPrompt = input.prompt.toLowerCase()
  const isMarketplace =
    input.appType === "simple_marketplace" ||
    /\b(jual|beli|toko|dagang|market|produk|ecommerce|commerce)\b/i.test(lowerPrompt)
  const isNews = /\b(berita|portal|majalah|artikel|desa)\b/i.test(lowerPrompt)

  if (isMarketplace) {
    return [
      {
        path: "app/layout.tsx",
        language: "tsx",
        content: `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "JBB Marketplace",
  description: "Preview marketplace lokal berbasis data dummy",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
      },
      {
        path: "app/page.tsx",
        language: "tsx",
        content: `const products = [
  { name: "Kurung Manuk Bambu", area: "Majalengka Kota", price: "Rp 85.000", status: "Ready" },
  { name: "Kurung Manuk Besi", area: "Kadipaten", price: "Rp 140.000", status: "Favorit" },
  { name: "Pakan Harian", area: "Jatiwangi", price: "Rp 18.000", status: "Stok aman" },
  { name: "Aksesoris Tangkringan", area: "Leuwimunding", price: "Rp 25.000", status: "Baru" },
]

const stats = [
  { label: "Produk aktif", value: "48" },
  { label: "Penjual lokal", value: "12" },
  { label: "Area layanan", value: "Majalengka" },
]

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="text-sm font-medium text-rose-600">JBB Majalengka</p>
            <h1 className="text-2xl font-bold">Jual beli kurung manuk lokal</h1>
          </div>
          <a className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white" href="#produk">
            Lihat produk
          </a>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Preview cepat</p>
          <h2 className="mt-3 text-4xl font-bold leading-tight">Pasar sederhana untuk kurung manuk dan kebutuhan hobi.</h2>
          <p className="mt-4 max-w-2xl text-slate-600">
            Semua data masih dummy agar preview tampil cepat. Tahap berikutnya bisa menambahkan database, login penjual,
            dan checkout.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {stats.map((item) => (
              <div key={item.label} className="rounded-md border bg-slate-50 p-4">
                <p className="text-2xl font-bold">{item.value}</p>
                <p className="text-sm text-slate-500">{item.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h3 className="font-semibold">Kategori populer</h3>
          <div className="mt-4 grid gap-3">
            {["Kurung bambu", "Kurung besi", "Pakan", "Aksesoris"].map((item) => (
              <div key={item} className="flex items-center justify-between rounded-md bg-slate-100 px-4 py-3">
                <span>{item}</span>
                <span className="text-sm text-slate-500">Dummy</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="produk" className="mx-auto max-w-6xl px-6 pb-10">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((product) => (
            <article key={product.name} className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="mb-4 flex h-28 items-center justify-center rounded-md bg-rose-50 text-sm font-semibold text-rose-700">
                Foto produk
              </div>
              <h3 className="font-semibold">{product.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{product.area}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="font-bold">{product.price}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{product.status}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
`,
      },
      {
        path: "app/globals.css",
        language: "css",
        content: `@import "tailwindcss";

:root {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f8fafc;
  font-family: Arial, Helvetica, sans-serif;
}
`,
      },
    ]
  }

  return [
    {
      path: "app/layout.tsx",
      language: "tsx",
      content: `import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Swift Preview",
  description: "Preview awal berbasis data dummy",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  )
}
`,
    },
    {
      path: "app/page.tsx",
      language: "tsx",
      content: `const cards = [
  { title: "${isNews ? "Artikel utama" : "Konten utama"}", body: "Data dummy untuk memastikan preview tampil cepat." },
  { title: "Kategori", body: "Susun bagian penting tanpa koneksi database dulu." },
  { title: "Tahap lanjut", body: "Integrasi backend dilakukan setelah tampilan dasar berhasil." },
]

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold text-rose-600">Swift preview</p>
        <h1 className="mt-3 text-4xl font-bold">Preview awal siap ditampilkan</h1>
        <p className="mt-4 max-w-2xl text-slate-600">
          File ini dibuat sebagai fallback aman ketika output AI tidak lolos parser. Semua data masih dummy.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {cards.map((card) => (
            <article key={card.title} className="rounded-lg border bg-white p-5 shadow-sm">
              <h2 className="font-semibold">{card.title}</h2>
              <p className="mt-2 text-sm text-slate-600">{card.body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
`,
    },
    {
      path: "app/globals.css",
      language: "css",
      content: `@import "tailwindcss";

body {
  margin: 0;
  background: #f8fafc;
  font-family: Arial, Helvetica, sans-serif;
}
`,
    },
  ]
}

function mapLifecycleFailureToQualityStage(step?: ValidationLifecycleStep | null): GenerationQualityStage {
  if (!step) return "unknown"
  if (step === "static") return "static-validation"
  if (step === "tsx-validation") return "static-validation"
  if (step === "import-validation") return "static-validation"
  if (step === "component-contracts") return "static-validation"
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

function findStep(validation: ValidationLifecycleResult, name: ValidationLifecycleStep) {
  return validation.steps.find((step) => step.name === name)
}

function assertCompileGatePassed(validation: ValidationLifecycleResult) {
  const required: ValidationLifecycleStep[] = [
    "component-contracts",
    "static",
    "typecheck",
    "build",
    "runtime-smoke",
  ]
  const failed = required.find((name) => findStep(validation, name)?.status !== "passed")
  if (failed) {
    const step = findStep(validation, failed)
    throw new CompileGateError(
      `Compile gate blocked persistence: ${failed} did not pass${step?.message ? ` (${step.message})` : ""}.`
    )
  }
  const score = renderScore(validation)
  if (score < MIN_RENDER_SCORE_TO_PERSIST) {
    throw new CompileGateError(
      `Compile gate blocked persistence: renderScore ${score} is below threshold ${MIN_RENDER_SCORE_TO_PERSIST}.`
    )
  }
}

function renderScore(validation: ValidationLifecycleResult | null) {
  if (!validation) return 0
  const runtimeStep = validation.steps.find((step) => step.name === "runtime-smoke")
  if (runtimeStep?.status !== "passed") return 0
  const verification = runtimeStep.data?.runtimeVerification as {
    ok?: boolean
    checks?: Array<{ name?: string; status?: string; category?: string }>
    diagnostics?: Record<string, unknown>
  } | null | undefined
  if (!verification) return 100

  const checks = Array.isArray(verification.checks) ? verification.checks : []
  const diagnostics = verification.diagnostics || {}
  const routeSuccess = checks.some((check) => /homepage_render|route_render/.test(String(check.name || "")) && check.status === "passed")
  const browserRenderSuccess = checks.some((check) => check.name === "runtime.browser_navigation" && check.status === "passed")
  const hydrationSuccess = asStringArray(diagnostics.hydrationErrors).length === 0
  const componentSuccess =
    asStringArray(diagnostics.reactErrorBoundaryOutput).length === 0 &&
    asStringArray(diagnostics.pageRenderStackTraces).length === 0 &&
    asStringArray(diagnostics.serverClientComponentMismatches).length === 0

  return [
    routeSuccess ? 25 : 0,
    browserRenderSuccess ? 25 : 0,
    hydrationSuccess ? 25 : 0,
    componentSuccess ? 25 : 0,
  ].reduce((sum, value) => sum + value, 0)
}

function validationLogLines(validation: ValidationLifecycleResult | null, kind: "build" | "runtime") {
  if (!validation) return []
  const names: ValidationLifecycleStep[] = kind === "build"
    ? ["typecheck", "lint", "build", "preview-compile"]
    : ["runtime-smoke"]
  return validation.steps
    .filter((step) => names.includes(step.name))
    .flatMap((step) => {
      const logs = Array.isArray(step.data?.logs) ? step.data.logs.map(String) : []
      return [
        `${step.name}:${step.status}:${step.policy}:${step.durationMs}ms${step.message ? `:${step.message}` : ""}`,
        ...logs,
      ]
    })
}

function repairScore(validation: ValidationLifecycleResult | null) {
  if (!validation) return 0
  const validatorSuccess = validation.steps.some((step) =>
    ["tsx-validation", "import-validation", "static"].includes(step.name) && step.status === "passed"
  )
  const buildSuccess = validation.steps.some((step) => step.name === "build" && step.status === "passed")
  const runtimeSuccess = validation.steps.some((step) => step.name === "runtime-smoke" && step.status === "passed")
  return [
    validatorSuccess ? 30 : 0,
    buildSuccess ? 35 : 0,
    runtimeSuccess ? 35 : 0,
  ].reduce((sum, value) => sum + value, 0)
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
      renderScore: input.validation ? renderScore(input.validation) : null,
      renderScoreThreshold: MIN_RENDER_SCORE_TO_PERSIST,
    },
  })
}

export async function executeGenerationJob(
  input: ExecuteGenerationJobInput,
  deps: ExecuteGenerationJobDeps
) {
  const promptLanguage = input.promptLanguage || "id"
  const jobStartedAt = performance.now()
  const correlation = createCorrelationIds({
    correlationId: input.correlationId || input.jobId,
    traceId: input.traceId,
    executionChainId: input.executionChainId,
  })
  const traceContext = {
    taskId: input.jobId,
    sessionId: null,
    agentType: "generation-orchestrator",
    correlationId: correlation.correlationId,
    traceId: correlation.traceId,
    executionChainId: correlation.executionChainId,
  }
  const metrics: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    correlation,
    projectStateLoaded: false,
    projectStateFilesCount: 0,
    conversationHistoryUsed: false,
    dependencyGraphNodes: 0,
    patchOperations: 0,
    createOperations: 0,
    modifyOperations: 0,
    deleteOperations: 0,
    fullRewriteDetected: 0,
    changedFilesTotal: 0,
    changedFileEvents: 0,
  }
  const developerDiagnostics = createDeveloperGenerationDiagnostics()
  let plan: GenerationPlan | null = null
  let blueprint: ControlledAppBlueprint | null = null
  let validation: ValidationLifecycleResult | null = null
  let repairAttempt = 0
  let providerLatencyMs = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const workflowMemory: AgentWorkflowMemoryEntry[] = []
  let buildLogs: string[] = []
  const rawOutputs: Array<Record<string, unknown>> = []
  let lastErrorSignature = ""
  let lastBuildOutputSignature = ""
  let repairStopReason: string | null = null

  try {
    assertNotAborted(input.signal)
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: "PLANNING",
      status: "started",
      reason: "Generation planner started",
    })
    await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    traceExecution(traceContext, "planner_started", {
      projectId: input.projectId,
      selectedModel: input.selectedModel,
    })
    recordGenerationStageTelemetry({
      context: traceContext,
      stage: "planning",
      status: "started",
      meta: {
        projectId: input.projectId,
        selectedModel: input.selectedModel,
      },
    })
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

    const [loadedProjectState, previousPromptCount, previousMemoryJson] = await Promise.all([
      loadProjectState({
        projectId: input.projectId,
        prompt: input.prompt,
        modifiedPaths: extractRequestedFilePaths(input.prompt),
      }),
      deps.loadGenerationHistoryCount
        ? deps.loadGenerationHistoryCount(input.projectId).catch((error) => {
            log("warn", "generation_history_count_failed", {
              jobId: input.jobId,
              projectId: input.projectId,
              error: error instanceof Error ? error.message : String(error),
            })
            return 0
          })
        : Promise.resolve(0),
      deps.loadProjectMemoryJson
        ? deps.loadProjectMemoryJson(input.projectId).catch((error) => {
            log("warn", "architecture_memory_load_failed", {
              jobId: input.jobId,
              projectId: input.projectId,
              error: error instanceof Error ? error.message : String(error),
            })
            return null
          })
        : Promise.resolve(null),
    ])
    let projectState = loadedProjectState
    const projectStatePromptBlock = buildProjectStatePromptBlock(projectState)
    let existingFiles = projectState.files
    metrics.projectStateLoaded = true
    metrics.projectStateFilesCount = projectState.files.length
    metrics.conversationHistoryUsed = projectState.conversationHistory.length > 0
    metrics.dependencyGraphNodes = Object.keys(projectState.dependencyGraph.imports).length
    metrics.projectStateAudit = {
      loaded: true,
      filesCount: projectState.files.length,
      conversationHistoryCount: projectState.conversationHistory.length,
      dependencyGraphNodes: Object.keys(projectState.dependencyGraph.imports).length,
      contextFiles: projectState.metadata.context.selectedPaths,
      contextTotalChars: projectState.metadata.context.totalChars,
    }
    assertNotAborted(input.signal)
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "project_state.loaded",
      stage: "planning",
      status: "running",
      message: "Project state loaded before generation",
      data: {
        fileCount: projectState.files.length,
        version: projectState.metadata.version,
        contextFiles: projectState.metadata.context.selectedPaths,
        maxFiles: 10,
        maxTotalChars: 64 * 1024,
      },
    })
    const prePlanScaffoldValidation = validateProjectScaffold({
      paths: existingFiles.map((file) => file.path),
    })
    let prePlanScaffoldRepairFiles: GeneratedFile[] = []
    if (!prePlanScaffoldValidation.ok) {
      await transition(input.jobId, "scaffolding", "Repairing missing baseline scaffold", 8, {
        missingFiles: prePlanScaffoldValidation.missingFiles,
      })
      prePlanScaffoldRepairFiles = buildMissingScaffoldFiles(prePlanScaffoldValidation.missingFiles)
      if (prePlanScaffoldRepairFiles.length !== prePlanScaffoldValidation.missingFiles.length) {
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "FAILED",
          status: "failed",
          reason: `Scaffold repair failed: unsupported missing baseline ${prePlanScaffoldValidation.missingFiles.join(", ")}`,
          data: {
            missingFiles: prePlanScaffoldValidation.missingFiles,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        throw new Error(`Scaffold repair failed: unsupported missing baseline ${prePlanScaffoldValidation.missingFiles.join(", ")}`)
      }

      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "REPAIRING",
        status: "started",
        reason: "Scaffold repair isolated to missing baseline files before architecture planning",
        repairAttempt: 1,
        data: {
          missingFiles: prePlanScaffoldValidation.missingFiles,
          filesToEdit: prePlanScaffoldRepairFiles.map((file) => normalizePath(file.path)),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)

      const previousPrePlanFiles = existingFiles
      const normalizedPrePlanScaffold = normalizeGeneratedDependencies(mergeFilesByPath(existingFiles, prePlanScaffoldRepairFiles))
      existingFiles = normalizedPrePlanScaffold.files
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "scaffolding",
        message: "Baseline scaffold repaired",
        allFiles: existingFiles,
        previousFiles: previousPrePlanFiles,
        changedFiles: prePlanScaffoldRepairFiles,
        deletedPaths: [],
        source: "repair",
        data: {
          scaffoldRepairOnly: true,
          beforeArchitecturePlanning: true,
          missingFiles: prePlanScaffoldValidation.missingFiles,
          addedPackages: normalizedPrePlanScaffold.addedPackages,
          normalizedPackages: normalizedPrePlanScaffold.normalizedPackages,
        },
      })

      const repairedPrePlanScaffold = validateProjectScaffold({
        paths: existingFiles.map((file) => file.path),
      })
      if (!repairedPrePlanScaffold.ok) {
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "FAILED",
          status: "failed",
          reason: `Scaffold validation failed after repair: ${repairedPrePlanScaffold.missingFiles.join(", ")}`,
          repairAttempt: 1,
          data: {
            missingFiles: repairedPrePlanScaffold.missingFiles,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        throw new Error(`Scaffold validation failed after repair: missing ${repairedPrePlanScaffold.missingFiles.join(", ")}`)
      }

      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: "passed",
        reason: "Scaffold validation passed before architecture planning",
        repairAttempt: 1,
        data: {
          checkedFiles: repairedPrePlanScaffold.checkedFiles.slice(0, 40),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    } else {
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: "passed",
        reason: "Baseline scaffold validation passed before architecture planning",
        data: {
          checkedFiles: prePlanScaffoldValidation.checkedFiles.slice(0, 40),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    }

    plan = buildGenerationPlan({
      prompt: input.prompt,
      existingFiles,
      collaborationMode: input.collaborationMode,
      previewContext: input.previewContext,
      previousMemoryJson,
    })
    blueprint = getControlledAppBlueprint(plan.appType)
    const intentTemplate = selectIntentTemplate(input.prompt)
    metrics.intentTemplate = intentTemplate
      ? {
          id: intentTemplate.id,
          label: intentTemplate.label,
          path: intentTemplate.path,
          requiredCapabilities: intentTemplate.requiredCapabilities,
        }
      : null
    metrics.componentRegistry = {
      selectedTemplate: intentTemplate?.id || null,
      selectedRegistryComponents: selectedRegistryComponentsForTemplate(intentTemplate?.id || null),
    }
    recordGenerationStageTelemetry({
      context: traceContext,
      stage: "planning",
      status: "passed",
      meta: {
        projectId: input.projectId,
        appType: plan.appType,
        generationMode: plan.generationMode,
        productionMode: plan.productionMode,
        targetPaths: plan.allowedFileScope.targetPaths,
      },
    })
    const appPlan = buildAppPlan({ prompt: input.prompt, plan })
    developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
    developerDiagnostics.plannerConfidence = plan.orchestration.plannerConfidence
    developerDiagnostics.selectedArchetype = plan.orchestration.selectedArchetype
    developerDiagnostics.validationStatus = plan.orchestration.validationStatus
    developerDiagnostics.failedScope = plan.orchestration.failedScope
    developerDiagnostics.allowedScope = plan.orchestration.allowedScope
    developerDiagnostics.rejectedFiles = plan.orchestration.rejectedFiles
    developerDiagnostics.previewStatus = plan.orchestration.previewStatus
    developerDiagnostics.commitStatus = plan.orchestration.commitStatus
    developerDiagnostics.orchestrationModels = {
      plannerModel: plan.orchestration.plannerModel,
      architectureModel: plan.orchestration.architectureModel,
      builderModel: plan.orchestration.builderModel,
      repairModel: plan.orchestration.repairModel,
      validatorModel: plan.orchestration.validatorModel,
      uiEnhancementModel: plan.orchestration.uiEnhancementModel,
    }
    if (prePlanScaffoldRepairFiles.length > 0) {
      appendRepairPath(plan.orchestration, {
        attempt: 1,
        reason: `Missing baseline scaffold files: ${prePlanScaffoldRepairFiles.map((file) => normalizePath(file.path)).join(", ")}`,
        targetFiles: prePlanScaffoldRepairFiles.map((file) => normalizePath(file.path)),
        failedScope: "scaffold",
        issueType: "architecture_mismatch",
        fixPlan: "create only the missing baseline scaffold files before architecture planning",
      })
      developerDiagnostics.repairAttempts.push({
        attempt: 1,
        reason: "Missing baseline scaffold files repaired before architecture planning",
        targetFiles: prePlanScaffoldRepairFiles.map((file) => normalizePath(file.path)),
        repairedArtifactSummary: summarizeGeneratedFiles(prePlanScaffoldRepairFiles),
        validatorResult: {
          status: "passed",
          missingFiles: [],
        },
      })
    }
    developerDiagnostics.repairPath = plan.orchestration.repairPath
    developerDiagnostics.plannerOutput = {
      objective: plan.objective,
      generationMode: plan.generationMode,
      appType: plan.appType,
      productionMode: plan.productionMode,
      intent: plan.intent,
      structuredIntent: plan.structuredIntent,
      incrementalEdit: plan.incrementalEdit,
      filePlan: plan.filePlan,
      agentTasks: plan.agentTasks,
      actionPlan: plan.actionPlan,
      appPlan,
      orchestrationDiagnostics: plan.orchestration,
      architectureOutput: plan.orchestration.architectureOutput,
      plannerModel: plan.orchestration.plannerModel,
      architectureModel: plan.orchestration.architectureModel,
      builderModel: plan.orchestration.builderModel,
      repairModel: plan.orchestration.repairModel,
      plannerConfidence: plan.orchestration.plannerConfidence,
      selectedArchetype: plan.orchestration.selectedArchetype,
      validationStatus: plan.orchestration.validationStatus,
      failedScope: plan.orchestration.failedScope,
      allowedScope: plan.orchestration.allowedScope,
      rejectedFiles: plan.orchestration.rejectedFiles,
      previewStatus: plan.orchestration.previewStatus,
      commitStatus: plan.orchestration.commitStatus,
      intentGraph: plan.orchestration.graphs.intentGraph,
      routeGraph: plan.orchestration.graphs.routeGraph,
      componentGraph: plan.orchestration.graphs.componentGraph,
      architecturePlan: plan.architecture,
      projectMemoryGraph: plan.projectMemory,
      dependencyGraph: plan.dependencyGraph,
    }
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: "PLANNING",
      status: "passed",
      reason: "Architecture plan ready",
      data: {
        appType: plan.appType,
        productionMode: plan.productionMode,
        fileCount: plan.filePlan.length,
      },
    })
    await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    log("info", "intent", {
      jobId: input.jobId,
      projectId: input.projectId,
      correlationId: correlation.correlationId,
      traceId: correlation.traceId,
      executionChainId: correlation.executionChainId,
      objective: plan.objective,
      appType: plan.appType,
      productionMode: plan.productionMode,
      editMode: plan.editPlan.mode,
      intent: intentStorageKey(plan.intent),
      selectedTemplate: intentTemplate?.id || null,
      selectedRegistryComponents: selectedRegistryComponentsForTemplate(intentTemplate?.id || null),
    })
    log("info", "plan", {
      jobId: input.jobId,
      projectId: input.projectId,
      tasks: plan.agentTasks,
      actions: plan.actionPlan,
      filePlan: plan.filePlan,
    })
    log("info", "app_plan", {
      jobId: input.jobId,
      projectId: input.projectId,
      appPlan,
    })
    log("info", "generation_manifest_planned", {
      jobId: input.jobId,
      projectId: input.projectId,
      classification: plan.productionMode,
      promptClassification: plan.objective,
      productionMode: plan.productionMode,
      fileCount: plan.filePlan.length,
      generatedFiles: plan.filePlan.map((file) => file.path),
    })
    await GenerationJobService.transition(input.jobId, {
      type: "job.plan.ready",
      status: "running",
      stage: "planning",
      label: "Architecture plan ready",
      progress: 10,
      intent: intentStorageKey(plan.intent),
      usedAutoRepair: false,
      plan,
      context: {
        fileCount: existingFiles.length,
      },
      message: "Architecture plan ready",
      data: {
        objective: plan.objective,
        generationMode: plan.generationMode,
        appType: plan.appType,
        productionMode: plan.productionMode,
        maxFilesThisPass: plan.maxFilesThisPass,
        intent: plan.intent,
        structuredIntent: plan.structuredIntent,
        incrementalEdit: plan.incrementalEdit,
        blueprint: plan.blueprint,
        architecturePlan: plan.architecture,
        projectMemoryGraph: plan.projectMemory,
        dependencyGraph: plan.dependencyGraph,
        editPlan: {
          mode: plan.editPlan.mode,
          intent: plan.editPlan.intent,
          targetPaths: plan.editPlan.targetPaths,
          allowedNewPaths: plan.editPlan.allowedNewPaths,
        },
        filePlan: plan.filePlan,
        agentTasks: plan.agentTasks,
        actionPlan: plan.actionPlan,
        appPlan,
      },
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "allowed_scope.defined",
      stage: "planning",
      status: "running",
      message: "ALLOWED_FILE_SCOPE defined before generation",
      data: {
        contract: plan.allowedFileScope,
        allowedScope: plan.allowedFileScope.allowedPaths,
        forbiddenPatterns: plan.orchestration.architectureOutput.forbiddenPatterns,
      },
    })
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: "PLANNING",
      status: "passed",
      reason: "Allowed file scope frozen before generation",
      data: {
        contract: plan.allowedFileScope,
        allowedScope: plan.allowedFileScope.allowedPaths,
      },
    })
    await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)

    let workingFiles = [...existingFiles]
    let tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
    const initialScaffoldValidation = validateProjectScaffold({
      paths: workingFiles.map((file) => file.path),
    })
    if (!initialScaffoldValidation.ok) {
      await transition(input.jobId, "scaffolding", "Repairing missing baseline scaffold", 14, {
        missingFiles: initialScaffoldValidation.missingFiles,
      })
      const scaffoldRepairFiles = buildMissingScaffoldFiles(initialScaffoldValidation.missingFiles)
      if (scaffoldRepairFiles.length !== initialScaffoldValidation.missingFiles.length) {
        markOrchestrationValidation(plan.orchestration, {
          status: "blocked",
          failedScope: "scaffold",
          failures: initialScaffoldValidation.missingFiles.map((file) => `Missing scaffold file: ${file}`),
        })
        developerDiagnostics.validationStatus = plan.orchestration.validationStatus
        developerDiagnostics.failedScope = plan.orchestration.failedScope
        developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        throw new Error(`Scaffold repair failed: unsupported missing baseline ${initialScaffoldValidation.missingFiles.join(", ")}`)
      }

      appendRepairPath(plan.orchestration, {
        attempt: 1,
        reason: `Missing baseline scaffold files: ${initialScaffoldValidation.missingFiles.join(", ")}`,
        targetFiles: scaffoldRepairFiles.map((file) => normalizePath(file.path)),
        failedScope: "scaffold",
        issueType: "architecture_mismatch",
        fixPlan: "create only the missing baseline scaffold files and rerun scaffold validation",
      })
      developerDiagnostics.repairPath = plan.orchestration.repairPath
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      developerDiagnostics.validationStatus = "failed"
      developerDiagnostics.failedScope = "scaffold"
      developerDiagnostics.repairAttempts.push({
        attempt: 1,
        reason: `Missing baseline scaffold files: ${initialScaffoldValidation.missingFiles.join(", ")}`,
        targetFiles: scaffoldRepairFiles.map((file) => normalizePath(file.path)),
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "REPAIRING",
        status: "started",
        reason: "Scaffold repair isolated to missing baseline files",
        repairAttempt: 1,
        data: {
          missingFiles: initialScaffoldValidation.missingFiles,
          filesToEdit: scaffoldRepairFiles.map((file) => normalizePath(file.path)),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)

      const previousScaffoldFiles = workingFiles
      const normalizedScaffold = normalizeGeneratedDependencies(mergeFilesByPath(workingFiles, scaffoldRepairFiles))
      workingFiles = normalizedScaffold.files
      tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "scaffolding",
        message: "Baseline scaffold repaired",
        allFiles: workingFiles,
        previousFiles: previousScaffoldFiles,
        changedFiles: scaffoldRepairFiles,
        deletedPaths: [],
        source: "repair",
        data: {
          scaffoldRepairOnly: true,
          missingFiles: initialScaffoldValidation.missingFiles,
          addedPackages: normalizedScaffold.addedPackages,
          normalizedPackages: normalizedScaffold.normalizedPackages,
        },
      })

      const repairedScaffoldValidation = validateProjectScaffold({
        paths: workingFiles.map((file) => file.path),
      })
      if (!repairedScaffoldValidation.ok) {
        markOrchestrationValidation(plan.orchestration, {
          status: "blocked",
          failedScope: "scaffold",
          failures: repairedScaffoldValidation.missingFiles.map((file) => `Missing scaffold file after repair: ${file}`),
        })
        developerDiagnostics.validationStatus = plan.orchestration.validationStatus
        developerDiagnostics.failedScope = plan.orchestration.failedScope
        developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
        const scaffoldRepairDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === 1)
        if (scaffoldRepairDiagnostic) {
          scaffoldRepairDiagnostic.validatorResult = {
            status: "failed",
            missingFiles: repairedScaffoldValidation.missingFiles,
          }
          scaffoldRepairDiagnostic.failedBecause = `Scaffold validation still missing ${repairedScaffoldValidation.missingFiles.join(", ")}`
        }
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "REPAIRING",
          status: "failed",
          reason: "Scaffold validation failed after isolated repair",
          repairAttempt: 1,
          data: {
            missingFiles: repairedScaffoldValidation.missingFiles,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        throw new Error(`Scaffold validation failed after repair: missing ${repairedScaffoldValidation.missingFiles.join(", ")}`)
      }

      markOrchestrationValidation(plan.orchestration, {
        status: "passed",
        failedScope: "",
        failures: [],
      })
      developerDiagnostics.validationStatus = plan.orchestration.validationStatus
      developerDiagnostics.failedScope = plan.orchestration.failedScope
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      const scaffoldRepairDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === 1)
      if (scaffoldRepairDiagnostic) {
        scaffoldRepairDiagnostic.validatorResult = {
          status: "passed",
          missingFiles: [],
        }
      }
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: "passed",
        reason: "Scaffold validation passed after isolated repair",
        repairAttempt: 1,
        data: {
          checkedFiles: repairedScaffoldValidation.checkedFiles.slice(0, 40),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    } else {
      markOrchestrationValidation(plan.orchestration, {
        status: "passed",
        failedScope: "",
        failures: [],
      })
      developerDiagnostics.validationStatus = plan.orchestration.validationStatus
      developerDiagnostics.failedScope = plan.orchestration.failedScope
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: "passed",
        reason: "Baseline scaffold validation passed",
        data: {
          checkedFiles: initialScaffoldValidation.checkedFiles.slice(0, 40),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    }

    const initialObservation = observeAgentContext({
      prompt: input.prompt,
      plan,
      files: workingFiles,
      buildLogs,
      previousAttempts: workflowMemory,
    })
    log("info", "agent_observe", {
      jobId: input.jobId,
      projectId: input.projectId,
      iteration: 1,
      ...summarizeAgentObservation(initialObservation),
    })
    log("info", "agent_plan", {
      jobId: input.jobId,
      projectId: input.projectId,
      iteration: 1,
      tasks: plan.agentTasks,
      actions: plan.actionPlan,
    })

    if (plan.generationMode === "PATCH") {
      await transition(input.jobId, "generating", "Applying scoped incremental edit", 35, {
        generationMode: plan.generationMode,
        editIntent: plan.incrementalEdit.editIntent,
        affectedFiles: plan.incrementalEdit.affectedFiles,
        relatedFiles: plan.incrementalEdit.relatedFiles,
      })
      const patch = applyDeterministicIncrementalPatch({
        prompt: input.prompt,
        files: workingFiles,
        plan: plan.incrementalEdit,
      })

      if (patch.applied) {
        const scopedValidation = validateIncrementalPatch({
          files: patch.files,
          changedFiles: patch.changedFiles,
          plan: plan.incrementalEdit,
        })
        const scopedEditResult = buildScopedEditResult({
          plan: plan.incrementalEdit,
          patch,
          validation: scopedValidation,
        })
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: scopedValidation.ok ? "VALIDATING" : "REPAIRING",
          status: scopedValidation.ok ? "passed" : "failed",
          reason: scopedValidation.ok ? "Incremental edit passed scoped validation" : "Incremental edit failed scoped validation",
          data: {
            generationMode: plan.generationMode,
            editIntent: plan.incrementalEdit.editIntent,
            affectedFiles: plan.incrementalEdit.affectedFiles,
            relatedFiles: plan.incrementalEdit.relatedFiles,
            patchPlan: patch.patchPlan || null,
            patchSummary: patch.patchSummary,
            incrementalValidator: scopedValidation,
            scopedEditResult,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)

        if (scopedValidation.ok) {
          const previousWorkingFiles = workingFiles
          workingFiles = patch.files
          await emitGeneratedFilesUpdate({
            jobId: input.jobId,
            stage: "validating",
            message: "Scoped edit ready in Explorer",
            allFiles: workingFiles,
            previousFiles: previousWorkingFiles,
            changedFiles: patch.changedFiles,
            deletedPaths: [],
            source: "slice",
            data: {
              generationMode: plan.generationMode,
              editIntent: plan.incrementalEdit.editIntent,
              affectedFiles: plan.incrementalEdit.affectedFiles,
              patchPlan: patch.patchPlan || null,
              patchSummary: patch.patchSummary,
              incrementalValidator: scopedValidation,
              scopedEditResult,
            },
          })

          const finalProjectMemory = buildPersistentArchitectureSnapshot({
            files: workingFiles,
            intent: plan.structuredIntent,
            architecturePlan: plan.architecture,
            previousMemoryJson,
          })
          const finalDependencyGraph = buildArchitectureDependencyGraph({
            intent: plan.structuredIntent,
            architecturePlan: plan.architecture,
            memory: finalProjectMemory,
          })
          validation = await runValidationLifecycle({
            jobId: input.jobId,
            userId: input.userId,
            projectId: input.projectId,
            prompt: input.prompt,
            files: workingFiles,
            plan,
            blueprint,
            trace: {
              traceId: correlation.traceId,
              workerId: null,
            },
            signal: input.signal,
            emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
          })
          metrics.validationLifecycle = {
            ok: validation.ok,
            repairAttempts: 0,
            steps: validation.steps,
            sandboxValidation: validation.sandboxValidation,
            failure: validation.failure || null,
          }
          if (!validation.ok) {
            throw new CompileGateError(validation.failure?.message || "Scoped edit validation failed before persistence.")
          }
          assertCompileGatePassed(validation)
          const saveResult = await ProjectFilePersistenceService["saveBufferedArtifacts"]({
            projectId: input.projectId,
            prompt: input.prompt,
            files: workingFiles,
            projectMemoryJson: JSON.stringify({
              ...finalProjectMemory,
              dependencyGraph: finalDependencyGraph,
              architectureSnapshot: finalProjectMemory,
              structureLock: {
                lockedAt: new Date().toISOString(),
                generationMode: plan.generationMode,
                protectedPaths: finalProjectMemory.routes,
                components: finalProjectMemory.components,
                imports: finalProjectMemory.imports,
              },
              projectState: buildPersistedProjectStateSnapshot({
                files: workingFiles,
                validation,
              }),
            }),
            idempotencyKey: input.persistenceKey,
            generationJobId: input.jobId,
            intent: intentStorageKey(plan.intent),
            usedAutoRepair: false,
          })
          await GenerationJobService.appendEvent({
            jobId: input.jobId,
            type: "architecture_snapshot_persisted",
            stage: "persisting",
            status: "running",
            message: "Architecture graph snapshot persisted after scoped edit",
            data: {
              snapshotId: finalProjectMemory.snapshotId,
              routeCount: finalProjectMemory.routeGraph.length,
              componentCount: finalProjectMemory.componentGraph.length,
              serviceCount: finalProjectMemory.serviceGraph.length,
              apiCount: finalProjectMemory.apiGraph.length,
              dependencyImpact: patch.semanticDiagnostics?.dependencyImpact || [],
              routeImpact: patch.semanticDiagnostics?.routeImpact || [],
              componentGraphImpact: patch.semanticDiagnostics?.componentGraphImpact || [],
            },
          })
          await transition(input.jobId, "persisting", "Committing verified project state", 96, {
            historyId: saveResult.historyId,
            generatedFileCount: workingFiles.length,
          })
          const commitDiagnostics = await verifyProjectStateCommit({
            projectId: input.projectId,
            historyId: saveResult.historyId,
            generatedFiles: workingFiles,
            plan,
          })
          await GenerationJobService.appendEvent({
            jobId: input.jobId,
            type: "project_state_committed",
            stage: "persisting",
            status: "running",
            message: "Project state committed and verified",
            data: commitDiagnostics,
          })

          metrics.incrementalEdit = {
            generationMode: plan.generationMode,
            editIntent: plan.incrementalEdit.editIntent,
            affectedFiles: plan.incrementalEdit.affectedFiles,
            changedFiles: patch.changedFiles.map((file) => normalizePath(file.path)),
            patchPlan: patch.patchPlan || null,
            semanticOperation: patch.semanticOperation || null,
            semanticDiagnostics: patch.semanticDiagnostics || null,
            patchSummary: patch.patchSummary,
            validator: scopedValidation,
            scopedEditResult,
            previewPreserved: true,
          }
          metrics.persistence = {
            historyId: saveResult.historyId,
            fileDiff: saveResult.fileDiff,
            manifest: saveResult.manifest,
            verifiedFileCount: commitDiagnostics.committedFileCount,
            commitDiagnostics,
            commitStatus: "persisted",
          }
          await GenerationJobService.update(input.jobId, {
            metrics,
            intent: intentStorageKey(plan.intent),
            usedAutoRepair: false,
            previewUrl: null,
          })
          await appendOrchestrationEvent({
            jobId: input.jobId,
            trace: {
              traceId: correlation.traceId,
              workerId: null,
            },
            type: "incremental_edit_completed",
            stage: "completed",
            status: "completed",
            message: "Incremental edit completed",
            data: {
              generationMode: plan.generationMode,
              editIntent: plan.incrementalEdit.editIntent,
              affectedFiles: plan.incrementalEdit.affectedFiles,
              changedFiles: patch.changedFiles.map((file) => normalizePath(file.path)),
              patchPlan: patch.patchPlan || null,
              semanticOperation: patch.semanticOperation || null,
              semanticDiagnostics: patch.semanticDiagnostics || null,
              patchSummary: patch.patchSummary,
              incrementalValidator: scopedValidation,
              scopedEditResult,
              persistence: commitDiagnostics,
              previewPreserved: true,
            },
          })
          recordDeveloperDiagnostic(developerDiagnostics, {
            stage: "READY",
            status: "passed",
            reason: "Scoped incremental edit persisted",
            data: {
              incrementalEdit: metrics.incrementalEdit,
              persistence: commitDiagnostics,
            },
          })
          await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
          await GenerationJobService.markCompleted(input.jobId, saveResult.historyId, null)

          return {
            historyId: saveResult.historyId,
            files: workingFiles,
            previewUrl: null,
          }
        }

        const scopedRepairPayload = parseRepairPayload({
          mode: "scoped",
          affectedFiles: plan.incrementalEdit.affectedFiles,
          operations: [],
        })
        await appendOrchestrationEvent({
          jobId: input.jobId,
          trace: {
            traceId: correlation.traceId,
            workerId: null,
          },
          type: "scoped_edit_failed",
          stage: "failed",
          status: "failed",
          message: "Scoped edit validation failed; architecture repair was not invoked",
          data: {
            generationMode: plan.generationMode,
            editIntent: plan.incrementalEdit.editIntent,
            affectedFiles: plan.incrementalEdit.affectedFiles,
            incrementalValidator: scopedValidation,
            scopedRepairPayload,
            skippedArchitectureRepair: true,
          },
        })
        throw new Error("Scoped edit validation failed; architecture repair was not invoked")
      }

      await appendOrchestrationEvent({
        jobId: input.jobId,
        trace: {
          traceId: correlation.traceId,
          workerId: null,
        },
        type: "scoped_edit_provider_fallback",
        stage: "generating",
        status: "running",
        message: "Deterministic scoped edit did not match; continuing with provider scoped edit inside the frozen allowed scope",
        data: {
          generationMode: plan.generationMode,
          editIntent: plan.incrementalEdit.editIntent,
          affectedFiles: plan.incrementalEdit.affectedFiles,
          relatedFiles: plan.incrementalEdit.relatedFiles,
          deterministicPatchReason: patch.reason,
          allowedScope: plan.allowedFileScope,
          skippedScaffoldRegeneration: true,
          skippedArchitectureRepair: true,
          providerScopedEditAllowed: true,
        },
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "GENERATING",
        status: "passed",
        reason: "Deterministic scoped edit did not match; provider scoped edit fallback allowed",
        data: {
          generationMode: plan.generationMode,
          editIntent: plan.incrementalEdit.editIntent,
          affectedFiles: plan.incrementalEdit.affectedFiles,
          relatedFiles: plan.incrementalEdit.relatedFiles,
          deterministicPatchReason: patch.reason,
          allowedScope: plan.allowedFileScope,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    }

    const backendBlueprintFiles = buildMissingBackendBlueprintFiles({
      plan,
      prompt: input.prompt,
      files: workingFiles,
    })
    if (backendBlueprintFiles.length > 0) {
      const previousWorkingFiles = workingFiles
      const backendStartedAt = performance.now()
      const withBackend = mergeFilesByPath(workingFiles, backendBlueprintFiles)
      workingFiles = extractUiMockDataToServices(withBackend)
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files
      tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
      const changedPaths = new Set(backendBlueprintFiles.map((file) => normalizePath(file.path)))
      for (const file of workingFiles) {
        const previous = previousWorkingFiles.find((item) => normalizePath(item.path) === normalizePath(file.path))
        if (previous && previous.content !== file.content) changedPaths.add(normalizePath(file.path))
      }
      const changedFiles = workingFiles.filter((file) => changedPaths.has(normalizePath(file.path)))
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "GENERATING",
        status: "passed",
        reason: "Backend blueprint scaffold generated for production full-stack validation",
        data: {
          acceptedFileCount: backendBlueprintFiles.length,
          changedFiles: Array.from(changedPaths).sort(),
          addedPackages: normalized.addedPackages,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      const backendDurationMs = Math.round(performance.now() - backendStartedAt)
      await transition(input.jobId, "parsing", "Generating backend blueprint scaffold", 52, {
        source: "backend_blueprint_scaffold",
        fileCount: workingFiles.length,
        changedPaths: Array.from(changedPaths).sort(),
        addedPackages: normalized.addedPackages,
        durationMs: backendDurationMs,
      })
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "parsing",
        message: "Backend blueprint scaffold ready in Explorer",
        allFiles: workingFiles,
        previousFiles: previousWorkingFiles,
        changedFiles,
        deletedPaths: [],
        source: "backend_blueprint_scaffold",
        data: {
          durationMs: backendDurationMs,
          fileCount: workingFiles.length,
          addedPackages: normalized.addedPackages,
        },
      })
      log("info", "backend_blueprint_scaffold_completed", {
        jobId: input.jobId,
        projectId: input.projectId,
        source: "backend_blueprint_scaffold",
        fileCount: workingFiles.length,
        generatedFiles: backendBlueprintFiles.map((file) => normalizePath(file.path)),
        changedFiles: Array.from(changedPaths).sort(),
      })
    }

    const fastScaffoldFiles = buildFastClinicFullStackScaffold({
      plan,
      prompt: input.prompt,
    })

    if (fastScaffoldFiles) {
      const previousWorkingFiles = workingFiles
      const scaffoldStartedAt = performance.now()
      log("info", "agent_act", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        source: "fast_fullstack_scaffold",
        actions: fastScaffoldFiles.map((file) => ({
          action: previousWorkingFiles.some((existing) => normalizePath(existing.path) === normalizePath(file.path)) ? "modify" : "create",
          file: normalizePath(file.path),
        })),
      })
      workingFiles = mergeFilesByPath(workingFiles, fastScaffoldFiles)
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files
      tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: "passed",
        reason: "Fast full-stack scaffold accepted by validator",
        data: {
          acceptedFileCount: fastScaffoldFiles.length,
          rejectedFileCount: 0,
          changedFiles: fastScaffoldFiles.map((file) => normalizePath(file.path)).slice(0, 40),
          addedPackages: normalized.addedPackages,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      log("info", "agent_execute_tools", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        source: "fast_fullstack_scaffold",
        tools: ["readFile", "writeFile", "listFiles", "searchFiles", "runCommand"],
        changedFiles: fastScaffoldFiles.map((file) => normalizePath(file.path)),
        fileCount: tools.listFiles().length,
      })
      const scaffoldDurationMs = Math.round(performance.now() - scaffoldStartedAt)
      await transition(input.jobId, "parsing", "Generating compact full-stack clinic core", 55, {
        source: "fast_fullstack_scaffold",
        fileCount: workingFiles.length,
        changedPaths: fastScaffoldFiles.map((file) => file.path),
        addedPackages: normalized.addedPackages,
        durationMs: scaffoldDurationMs,
      })
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "parsing",
        message: "Compact full-stack clinic core ready in Explorer",
        allFiles: workingFiles,
        previousFiles: previousWorkingFiles,
        changedFiles: fastScaffoldFiles,
        deletedPaths: [],
        source: "fast_fullstack_scaffold",
        data: {
          durationMs: scaffoldDurationMs,
          fileCount: workingFiles.length,
          addedPackages: normalized.addedPackages,
        },
      })
      log("info", "generation_scaffold_completed", {
        jobId: input.jobId,
        projectId: input.projectId,
        source: "fast_fullstack_scaffold",
        fileCount: workingFiles.length,
        generatedFiles: summarizeGeneratedManifest(workingFiles),
      })
      log("info", "files_generated", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        source: "fast_fullstack_scaffold",
        files: fastScaffoldFiles.map((file) => normalizePath(file.path)),
      })
    } else {
      if (plan.editPlan.mode === "partial") {
        log("info", "edit_patch_started", {
          jobId: input.jobId,
          projectId: input.projectId,
          correlationId: correlation.correlationId,
          traceId: correlation.traceId,
          executionChainId: correlation.executionChainId,
        })
      }
      const usePreviewFoundationBatch =
        plan.productionMode === "preview" &&
        plan.editPlan.mode === "full" &&
        plan.filePlan.length > 1 &&
        plan.filePlan.length <= PREVIEW_FOUNDATION_FILE_LIMIT
      const useFullFrontendBatch =
        plan.productionMode === "full_frontend" &&
        plan.editPlan.mode === "full" &&
        plan.filePlan.length > 1
      const stagedEcommerce = isEcommerceStagedPlan(plan)
      const sliceBatchSize = stagedEcommerce
        ? 1
        : plan.productionMode === "production_fullstack"
        ? PRODUCTION_FULLSTACK_BATCH_SIZE
        : useFullFrontendBatch
          ? FULL_FRONTEND_BATCH_SIZE
        : usePreviewFoundationBatch
          ? plan.filePlan.length
          : 1

      for (
        let index = 0;
        index < plan.filePlan.length;
        index += sliceBatchSize
      ) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      const targets = plan.filePlan.slice(index, index + sliceBatchSize)
      const target = targets.length > 1
        ? {
            path: targets.map((item) => item.path).join(", "),
            reason:
              plan.productionMode === "production_fullstack"
                ? "Production full-stack batch keeps the job inside timeout while covering UI, API, data, and config"
                : plan.productionMode === "full_frontend"
                  ? "Full frontend batch builds a production-like component architecture"
                  : "Preview foundation batch keeps the first render inside the timeout budget",
            action: "create_or_update" as const,
          }
        : plan.filePlan[index]
      const sliceIndex = Math.floor(index / sliceBatchSize) + 1
      const sliceTotal = Math.ceil(plan.filePlan.length / sliceBatchSize)
      const currentPhase = targets[0]?.stage || "support"
      traceExecution(traceContext, "generation_started", {
        sliceIndex,
        sliceTotal,
        targetPaths: targets.map((item) => item.path),
      })
      const previousWorkingFiles = workingFiles
      const providerStartedAt = performance.now()
      const sliceObservation = observeAgentContext({
        prompt: input.prompt,
        plan,
        files: workingFiles,
        buildLogs,
        previousAttempts: workflowMemory,
        targetPaths: targets.map((item) => item.path),
      })
      log("info", "agent_observe", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        sliceIndex,
        sliceTotal,
        ...summarizeAgentObservation(sliceObservation),
      })
      const baseSlicePrompt = buildSlicePrompt({
          prompt: input.prompt,
          plan,
          blueprint,
          existingFiles: workingFiles,
          projectStateBlock: projectStatePromptBlock,
          target,
          targets,
          observation: sliceObservation,
      })
      log("info", "agent_act", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        sliceIndex,
        sliceTotal,
        actions: targets.map((item) => ({
          action: workingFiles.some((file) => normalizePath(file.path) === normalizePath(item.path)) ? "modify" : "create",
          file: normalizePath(item.path),
          reason: item.reason,
        })),
      })
      let response: Awaited<ReturnType<typeof runProviderAttempt>> | null = null
      let parsed: ReturnType<typeof parseGeneratedArtifact> | null = null
      let parseError: unknown = null

      for (let parseAttempt = 1; parseAttempt <= 2; parseAttempt += 1) {
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "GENERATING",
          status: "started",
          reason: `Generating artifact slice ${sliceIndex}/${sliceTotal}`,
          data: {
            target: target.path,
            parseAttempt,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        response = await runProviderAttempt({
          jobId: input.jobId,
          projectId: input.projectId,
          prompt: parseAttempt === 1
            ? baseSlicePrompt
            : [
                baseSlicePrompt,
                "",
                "RETRY_DUE_TO_MALFORMED_ARTIFACT:",
                "- Your previous response could not be parsed as a GeneratedArtifact.",
                "- Return ONLY valid JSON. No Markdown fences, no prose, no comments.",
                '- Use exactly this PATCH envelope: {"taskGraph":{"operations":[{"operation":"modifyFile","file":"app/page.tsx","content":"full updated file content"}]}}.',
                "- Use createFile, modifyFile, deleteFile, or patchFile operations only.",
                `- Do not return more than ${MAX_CHANGED_FILES_PER_REQUEST} changed files.`,
                `- Create or modify only exact paths in APPROVED_FILE_SCOPE: ${plan.allowedFileScope.allowedPaths.join(", ")}.`,
                "- Do not create helper/shell files such as components/app-shell.tsx unless that exact path is in APPROVED_FILE_SCOPE.",
                "- Paths must start with src/, app/, components/, sections/, lib/, prisma/, or an allowlisted root file such as package.json, tsconfig.json, next.config.ts, tailwind.config.ts, postcss.config.js, README.md, or .env.example. Paths must not contain .., ~, node_modules, .env, .git, package-lock.json, pnpm-lock.yaml, or yarn.lock.",
                "- files must be non-empty and every listed target file must be present.",
                `- Cover exactly this slice target: ${target.path}.`,
              ].join("\n"),
          purpose: "generate",
          orchestrationRole: "builder",
          logicalModel: plan.orchestration.builderModel,
          selectedModel: input.selectedModel,
          promptLanguage,
          signal: input.signal,
          generationContext: {
            projectId: input.projectId,
            generationMode: `${plan.productionMode}:${plan.editPlan.mode}`,
            prompt: input.prompt,
            previousPromptCount,
            existingFileCount: workingFiles.length,
            existingFiles: workingFiles,
          },
        })
        rawOutputs.push({
          phase: "generate",
          sliceIndex,
          sliceTotal,
          parseAttempt,
          target: target.path,
          hash: hashText(response.message),
          content: response.message,
        })
        assertNotAborted(input.signal)
        try {
          parsed = parseGeneratedArtifact(response.message)
          const missingRequiredTargets = missingArtifactTargetPaths(parsed, targets.map((item) => item.path))
          if (missingRequiredTargets.length > 0) {
            throw new Error(`MALFORMED_GENERATED_ARTIFACT:Missing required operation/file: ${missingRequiredTargets.join(", ")}`)
          }
          log("info", "generator_parsed_files", {
            jobId: input.jobId,
            projectId: input.projectId,
            sliceIndex,
            sliceTotal,
            parseAttempt,
            parsedFileCount: parsed.files.length,
            parsedFiles: filePathList(parsed.files),
            requiredFiles: targets.map((item) => normalizePath(item.path)),
            missingFiles: missingRequiredTargets,
            rawHash: hashText(response.message),
          })
          developerDiagnostics.generatedArtifactSummary = summarizeArtifactPayload({
            files: parsed.files,
            dependencies: parsed.dependencies,
            operations: parsed.taskGraph?.operations,
          })
          recordDeveloperDiagnostic(developerDiagnostics, {
            stage: "GENERATING",
            status: "passed",
            reason: `Artifact slice ${sliceIndex}/${sliceTotal} parsed`,
            data: developerDiagnostics.generatedArtifactSummary,
          })
          await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
          parseError = null
          break
        } catch (error) {
          parseError = error
          const parseFailure = error instanceof Error ? error.message : String(error)
          log("warn", "generator_output_contract_violation", {
            jobId: input.jobId,
            projectId: input.projectId,
            sliceIndex,
            sliceTotal,
            parseAttempt,
            target: target.path,
            requiredFiles: targets.map((item) => normalizePath(item.path)),
            parseFailure,
            rawHash: hashText(response.message),
            RAW_AI_OUTPUT: runtimeLogText(response.message),
          })
          if (parseAttempt >= 2) {
            const invalidArtifactPath = await persistInvalidArtifactReport({
              jobId: input.jobId,
              projectId: input.projectId,
              payload: response.message,
              parseFailure,
              schemaMismatch: parseFailure,
            }).catch(() => null)
            let partialFiles: GeneratedFile[] = []
            try {
              partialFiles = parseGeneratedArtifact(response.message, { strictFilesOnly: true }).files
            } catch {
              partialFiles = []
            }
            const fallback = buildMinimalRunnableFallbackProject({
              files: [...workingFiles, ...partialFiles],
              plan,
              reason: parseFailure,
              replaceCore: partialFiles.length === 0,
            })
            parsed = {
              files: fallback.files,
              dependencies: [],
              commands: [],
              summary: "Minimal runnable fallback project injected after invalid AI artifact output.",
              diagnostics: [
                "RAW_AI_OUTPUT failed generator output contract validation.",
                parseFailure,
              ],
              metadata: {
                fallback: "minimal_runnable_project",
                invalidArtifactPath,
                missingBeforeFallback: fallback.missingBefore,
              },
              repairs: [],
            }
            developerDiagnostics.artifactParseFailures.push({
              stage: "artifact_parsing",
              status: "failed",
              reason: publicArtifactParseError(error),
              parseAttempt,
              target: target.path,
              reportPath: invalidArtifactPath,
            })
            developerDiagnostics.reports.lastInvalidArtifactPath = invalidArtifactPath
            developerDiagnostics.generatedArtifactSummary = summarizeArtifactPayload({ files: parsed.files })
            recordDeveloperDiagnostic(developerDiagnostics, {
              stage: "GENERATING",
              status: "passed",
              reason: "Minimal runnable fallback injected after invalid generator output",
              data: {
                parseAttempt,
                target: target.path,
                reportPath: invalidArtifactPath,
                parserDiagnostic: publicArtifactParseError(error),
                fallbackInjectedPaths: fallback.injectedPaths,
                parsedFiles: filePathList(parsed.files),
              },
            })
            await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
            await appendOrchestrationEvent({
              jobId: input.jobId,
              trace: {
                traceId: correlation.traceId,
                workerId: null,
              },
              type: "minimal_fallback_injected",
              stage: "parsing",
              status: "running",
              message: "Minimal runnable fallback project injected after invalid AI output",
              data: {
                reason: parseFailure,
                reportPath: invalidArtifactPath,
                injectedPaths: fallback.injectedPaths,
                parsedFileCount: parsed.files.length,
              },
            })
            log("warn", "minimal_runnable_fallback_injected", {
              jobId: input.jobId,
              projectId: input.projectId,
              sliceIndex,
              sliceTotal,
              reason: parseFailure,
              reportPath: invalidArtifactPath,
              injectedPaths: fallback.injectedPaths,
              fileCount: parsed.files.length,
            })
            parseError = null
            break
          }
          if (!(error instanceof Error) || !error.message.startsWith("MALFORMED_GENERATED_ARTIFACT") || parseAttempt >= 2) {
            const invalidArtifactPath = await persistInvalidArtifactReport({
              jobId: input.jobId,
              projectId: input.projectId,
              payload: response.message,
              parseFailure: error instanceof Error ? error.message : String(error),
              schemaMismatch: error instanceof Error ? error.message : String(error),
            }).catch(() => null)
            developerDiagnostics.artifactParseFailures.push({
              stage: "artifact_parsing",
              status: "failed",
              reason: publicArtifactParseError(error),
              parseAttempt,
              target: target.path,
              reportPath: invalidArtifactPath,
            })
            developerDiagnostics.reports.lastInvalidArtifactPath = invalidArtifactPath
            recordDeveloperDiagnostic(developerDiagnostics, {
              stage: "GENERATING",
              status: "failed",
              reason: publicArtifactParseError(error),
              data: {
                parseAttempt,
                target: target.path,
                reportPath: invalidArtifactPath,
                parserDiagnostic: publicArtifactParseError(error),
              },
            })
            await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
            throw error
          }
          const publicMessage = publicArtifactParseError(error)
          const invalidArtifactPath = await persistInvalidArtifactReport({
            jobId: input.jobId,
            projectId: input.projectId,
            payload: response.message,
            parseFailure: error.message,
            schemaMismatch: error.message,
          }).catch(() => null)
          developerDiagnostics.artifactParseFailures.push({
            stage: "artifact_parsing",
            status: "failed",
            reason: publicArtifactParseError(error),
            parseAttempt,
            target: target.path,
            reportPath: invalidArtifactPath,
          })
          developerDiagnostics.reports.lastInvalidArtifactPath = invalidArtifactPath
          recordDeveloperDiagnostic(developerDiagnostics, {
            stage: "GENERATING",
            status: "failed",
            reason: `${publicArtifactParseError(error)}; retrying`,
            data: {
              parseAttempt,
              target: target.path,
              reportPath: invalidArtifactPath,
              parserDiagnostic: publicArtifactParseError(error),
            },
          })
          await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
          log("warn", "generation_slice_parse_retry", {
            jobId: input.jobId,
            projectId: input.projectId,
            sliceIndex,
            sliceTotal,
            target: target.path,
            error: error.message,
            publicMessage,
          })
          await transition(
            input.jobId,
            "parsing",
            publicMessage,
            Math.min(55, 15 + Math.round((sliceIndex / Math.max(1, sliceTotal)) * 35)),
            {
              target: target.path,
              parseAttempt,
              error: error.message,
              publicMessage,
            }
          )
        }
      }
      if (!response || !parsed) {
        throw parseError instanceof Error ? parseError : new Error("MALFORMED_GENERATED_ARTIFACT")
      }
      assertNotAborted(input.signal)
      log("info", "files_generated", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        sliceIndex,
        sliceTotal,
        operations: parsed.taskGraph?.operations.map((operation) => ({
          action: operation.action,
          file: normalizePath(operation.path),
          reason: operation.reason || null,
        })) || parsed.files.map((file) => ({
          action: workingFiles.some((existing) => normalizePath(existing.path) === normalizePath(file.path)) ? "modify" : "create",
          file: normalizePath(file.path),
          reason: null,
        })),
      })
      const sliceDurationMs = Math.round(performance.now() - providerStartedAt)
      providerLatencyMs += sliceDurationMs
      promptTokens += Math.max(0, response.tokenUsage?.promptTokens || 0)
      completionTokens += Math.max(0, response.tokenUsage?.completionTokens || 0)
      totalTokens += Math.max(0, response.tokenUsage?.totalTokens || 0)

      const allowedScopeResult = scopeArtifactToAllowedScope(parsed, plan)
      if (allowedScopeResult.rejected.length > 0) {
        const rejectedPaths = allowedScopeResult.rejected.map((item) => item.path)
        markScopeRejections(plan.orchestration, rejectedPaths)
        developerDiagnostics.rejectedFiles = plan.orchestration.rejectedFiles
        developerDiagnostics.validationStatus = plan.orchestration.validationStatus
        developerDiagnostics.failedScope = plan.orchestration.failedScope
        developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
        developerDiagnostics.validatorFailures.push({
          stage: "scope-validation",
          status: "failed",
          reason: "Generated artifact contained files outside ALLOWED_FILE_SCOPE",
          rejectedFiles: allowedScopeResult.rejected,
        })
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "VALIDATING",
          status: "failed",
          reason: "Rejected files outside ALLOWED_FILE_SCOPE; keeping accepted files only",
          data: {
            target: target.path,
            rejectedFiles: allowedScopeResult.rejected,
            allowedScope: plan.orchestration.allowedScope,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      }

      const scopedArtifact =
        plan.productionMode === "production_fullstack"
          ? scopeGeneratedArtifactToTargets(allowedScopeResult.artifact, targets.map((item) => item.path))
          : allowedScopeResult.artifact
      const scoped = scopedArtifact.taskGraph
        ? { acceptedFiles: scopedArtifact.files, rejectedFiles: [] as GeneratedFile[] }
        : plan.productionMode === "production_fullstack"
          ? filterGeneratedFilesToTargets(scopedArtifact.files, targets.map((item) => item.path))
          : filterFilesForPartialEdit(scopedArtifact.files, plan.editPlan)
      const hasAcceptedScopedArtifact =
        scoped.acceptedFiles.length > 0 ||
        Boolean(scopedArtifact.taskGraph?.operations.length)
      const patchOperations = hasAcceptedScopedArtifact
        ? artifactToPatchOperations({
            artifact: scopedArtifact,
            currentFiles: workingFiles,
          })
        : []
      const operationPaths = new Set(patchOperations.map((operation) => normalizePath(operation.file)))
      if (operationPaths.size > MAX_CHANGED_FILES_PER_REQUEST) {
        metrics.fullRewriteDetected = Number(metrics.fullRewriteDetected || 0) + 1
      }
      const patchResult = hasAcceptedScopedArtifact
        ? applyProjectPatchOperations(
            workingFiles,
            patchOperations,
            { maxChangedFilesPerRequest: MAX_CHANGED_FILES_PER_REQUEST }
          )
        : null
      metrics.patchOperations = Number(metrics.patchOperations || 0) + patchOperations.length
      metrics.createOperations = Number(metrics.createOperations || 0) + patchOperations.filter((operation) => operation.operation === "createFile").length
      metrics.modifyOperations = Number(metrics.modifyOperations || 0) + patchOperations.filter((operation) => operation.operation === "modifyFile" || operation.operation === "patchFile").length
      metrics.deleteOperations = Number(metrics.deleteOperations || 0) + patchOperations.filter((operation) => operation.operation === "deleteFile").length
      metrics.changedFilesTotal = Number(metrics.changedFilesTotal || 0) + (patchResult?.changedFiles.length || 0)
      metrics.changedFileEvents = Number(metrics.changedFileEvents || 0) + (patchResult ? 1 : 0)
      metrics.diffPatchAudit = {
        patchOperations: metrics.patchOperations,
        createOperations: metrics.createOperations,
        modifyOperations: metrics.modifyOperations,
        deleteOperations: metrics.deleteOperations,
        fullRewriteDetected: metrics.fullRewriteDetected,
        maxChangedFilesPerRequest: MAX_CHANGED_FILES_PER_REQUEST,
      }
      const dependencyResult = patchResult && scopedArtifact.dependencies.length > 0
        ? executeGeneratedTaskGraph(patchResult.files, undefined, [], scopedArtifact.dependencies)
        : null
      const executed = patchResult
        ? {
            files: dependencyResult?.files || patchResult.files,
            changedFiles: [
              ...patchResult.changedFiles,
              ...(dependencyResult?.changedFiles || []).filter((file) => !patchResult.changedFiles.some((changedFile) => normalizePath(changedFile.path) === normalizePath(file.path))),
            ],
            deletedPaths: patchResult.deletedPaths,
            installedDependencies: dependencyResult?.installedDependencies || [],
          }
        : {
            files: workingFiles,
            changedFiles: [] as GeneratedFile[],
            deletedPaths: [] as string[],
            installedDependencies: [] as string[],
          }
      workingFiles = executed.files
      const normalized = normalizeGeneratedDependencies(workingFiles)
      workingFiles = normalized.files
      tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
      if (scoped.rejectedFiles.length > 0) {
        developerDiagnostics.validatorFailures.push({
          stage: "scope_filter",
          status: "failed",
          reason: "Generated files rejected by edit scope",
          rejectedFiles: scoped.rejectedFiles.map((file) => file.path).slice(0, 20),
        })
      }
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "VALIDATING",
        status: scoped.rejectedFiles.length > 0 || allowedScopeResult.rejected.length > 0 ? "failed" : "passed",
        reason: scoped.rejectedFiles.length > 0 || allowedScopeResult.rejected.length > 0
          ? "Some generated files were rejected by scope validation"
          : `${stagedPhaseLabel(currentPhase)} artifact accepted by validator`,
        data: {
          stagedPhase: currentPhase,
          acceptedFileCount: scoped.acceptedFiles.length,
          rejectedFileCount: scoped.rejectedFiles.length + allowedScopeResult.rejected.length,
          rejectedFiles: [
            ...allowedScopeResult.rejected,
            ...scoped.rejectedFiles.map((file) => ({ path: normalizePath(file.path), reason: "File is outside provider-call target scope" })),
          ].slice(0, 20),
          changedFiles: executed.changedFiles.map((file) => normalizePath(file.path)).slice(0, 40),
          patchOperations: patchResult?.operations.map((operation) => ({
            operation: operation.operation,
            file: operation.file,
          })) || [],
          maxChangedFilesPerRequest: MAX_CHANGED_FILES_PER_REQUEST,
          addedPackages: normalized.addedPackages,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      log("info", "agent_execute_tools", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        sliceIndex,
        tools: ["readFile", "writeFile", "listFiles", "searchFiles", "runCommand"],
        changedFiles: executed.changedFiles.map((file) => normalizePath(file.path)),
        deletedPaths: executed.deletedPaths,
        fileCount: tools.listFiles().length,
      })
      const streamPaths = new Set([
        ...executed.changedFiles.map((file) => normalizePath(file.path)),
        ...(normalized.addedPackages.length > 0 || executed.installedDependencies.length > 0 ? ["package.json"] : []),
      ])
      const streamFiles = workingFiles.filter((file) => streamPaths.has(normalizePath(file.path)))

      await transition(
        input.jobId,
        "parsing",
        `Generating controlled file slice ${sliceIndex}/${sliceTotal}`,
        Math.min(55, 15 + Math.round((sliceIndex / Math.max(1, sliceTotal)) * 35)),
        {
          target: target.path,
          sliceDurationMs,
          parseFileCount: scopedArtifact.files.length,
          acceptedFileCount: scoped.acceptedFiles.length,
          rejectedFileCount: scoped.rejectedFiles.length + allowedScopeResult.rejected.length,
          rejectedFiles: [
            ...allowedScopeResult.rejected,
            ...scoped.rejectedFiles.map((file) => ({ path: normalizePath(file.path), reason: "File is outside provider-call target scope" })),
          ].slice(0, 8),
          taskOperationCount: scopedArtifact.taskGraph?.operations.length || 0,
          deletedPaths: executed.deletedPaths,
          installedDependencies: executed.installedDependencies,
          addedPackages: normalized.addedPackages,
        }
      )
      if (streamFiles.length > 0 || executed.deletedPaths.length > 0) {
        await emitGeneratedFilesUpdate({
          jobId: input.jobId,
          stage: "parsing",
          message: `File slice ${sliceIndex}/${sliceTotal} ready in Explorer`,
          allFiles: workingFiles,
          previousFiles: previousWorkingFiles,
          changedFiles: streamFiles,
          deletedPaths: executed.deletedPaths,
          source: "slice",
          data: {
            target: target.path,
            sliceIndex,
            sliceTotal,
            sliceDurationMs,
            acceptedFileCount: scoped.acceptedFiles.length,
            rejectedFileCount: scoped.rejectedFiles.length,
            taskOperationCount: scopedArtifact.taskGraph?.operations.length || 0,
            deletedPaths: executed.deletedPaths,
            installedDependencies: executed.installedDependencies,
            addedPackages: normalized.addedPackages,
          },
        })
      }

      log("info", "generation_slice_completed", {
        jobId: input.jobId,
        sliceIndex,
        sliceTotal,
        target: target.path,
        stagedPhase: currentPhase,
        durationMs: sliceDurationMs,
      })
      if (stagedEcommerce) {
        const nextPhase = plan.filePlan[index + sliceBatchSize]?.stage || null
        if (nextPhase !== currentPhase) {
          const checkpoint = validateStagedCheckpoint({
            phase: currentPhase,
            files: workingFiles,
            plan,
          })
          if (!checkpoint.ok) {
            markOrchestrationValidation(plan.orchestration, {
              status: "failed",
              failedScope: currentPhase,
              failures: checkpoint.failures,
            })
            appendRepairPath(plan.orchestration, {
              attempt: plan.orchestration.repairCount + 1,
              reason: `${stagedPhaseLabel(currentPhase)} checkpoint failed: ${checkpoint.failures.join("; ")}`,
              targetFiles: targets.map((item) => normalizePath(item.path)),
              failedScope: currentPhase,
              issueType: currentPhase === "scaffold" ? "architecture_mismatch" : "tsx_build",
              fixPlan: "repair only the failed staged scope before continuing",
            })
            developerDiagnostics.validationStatus = plan.orchestration.validationStatus
            developerDiagnostics.failedScope = plan.orchestration.failedScope
            developerDiagnostics.repairPath = plan.orchestration.repairPath
            developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
            recordDeveloperDiagnostic(developerDiagnostics, {
              stage: "VALIDATING",
              status: "failed",
              reason: `${stagedPhaseLabel(currentPhase)} checkpoint failed`,
              data: {
                stagedPhase: currentPhase,
                failures: checkpoint.failures,
              },
            })
            await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
            throw new Error(`${stagedPhaseLabel(currentPhase)} checkpoint failed: ${checkpoint.failures.join("; ")}`)
          }
          markOrchestrationValidation(plan.orchestration, {
            status: "passed",
            failedScope: "",
            failures: [],
          })
          developerDiagnostics.validationStatus = plan.orchestration.validationStatus
          developerDiagnostics.failedScope = plan.orchestration.failedScope
          developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
          recordDeveloperDiagnostic(developerDiagnostics, {
            stage: currentPhase === "scaffold" ? "STARTING_PREVIEW" : "VALIDATING",
            status: "passed",
            reason: `${stagedPhaseLabel(currentPhase)} checkpoint passed`,
            data: {
              stagedPhase: currentPhase,
              nextPhase,
            },
          })
          await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
          await transition(
            input.jobId,
            currentPhase === "scaffold" ? "compiling" : "validating",
            `${stagedPhaseLabel(currentPhase)} validated`,
            Math.min(70, 20 + Math.round((sliceIndex / Math.max(1, sliceTotal)) * 45)),
            {
              stagedPhase: currentPhase,
              nextPhase,
            }
          )
        }
      }
      }
    }
    if (plan.editPlan.mode === "partial") {
      log("info", "edit_patch_completed", {
        jobId: input.jobId,
        projectId: input.projectId,
        correlationId: correlation.correlationId,
        traceId: correlation.traceId,
        executionChainId: correlation.executionChainId,
      })
    }

    await GenerationJobService.assertNotCancelled(input.jobId)
    assertNotAborted(input.signal)
    traceExecution(traceContext, "validation_started", {
      projectId: input.projectId,
      fileCount: workingFiles.length,
    })
    recordGenerationStageTelemetry({
      context: traceContext,
      stage: "validation",
      status: "started",
      meta: {
        projectId: input.projectId,
        fileCount: workingFiles.length,
      },
    })
    traceExecution(traceContext, "build_started", {
      projectId: input.projectId,
      fileCount: workingFiles.length,
    })
    validation = await runValidationLifecycle({
      jobId: input.jobId,
      userId: input.userId,
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      plan,
      blueprint,
      trace: {
        traceId: correlation.traceId,
        workerId: null,
      },
      signal: input.signal,
      emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
    })
    recordGenerationStageTelemetry({
      context: traceContext,
      stage: "validation",
      status: validation.ok ? "passed" : "failed",
      meta: {
        projectId: input.projectId,
        failure: validation.failure || null,
        previewStatus: validation.previewStatus,
        steps: validation.steps.map((step) => ({
          name: step.name,
          status: step.status,
          durationMs: step.durationMs,
        })),
      },
    })
    markOrchestrationValidation(plan.orchestration, {
      status: validation.ok ? "passed" : "failed",
      failedScope: validation.failure?.step || "",
      failures: validation.ok ? [] : [validation.failure?.message || "Validation lifecycle failed"],
    })
    markPreviewStatus(plan.orchestration, validation.previewStatus)
    developerDiagnostics.validationStatus = plan.orchestration.validationStatus
    developerDiagnostics.failedScope = plan.orchestration.failedScope
    developerDiagnostics.previewStatus = plan.orchestration.previewStatus
    developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: validation.ok ? "STARTING_PREVIEW" : "VALIDATING",
      status: validation.ok ? "passed" : "failed",
      reason: validation.ok ? "Validation lifecycle passed" : validation.failure?.message || "Validation lifecycle failed",
      data: {
        previewStatus: validation.previewStatus,
        failure: validation.failure || null,
        steps: validation.steps.map((step) => ({
          name: step.name,
          status: step.status,
          policy: step.policy,
          durationMs: step.durationMs,
          reason: step.message || null,
        })),
      },
    })
    if (!validation.ok) {
      developerDiagnostics.validatorFailures.push({
        stage: validation.failure?.step || "validation",
        status: "failed",
        reason: validation.failure?.message || "Validation lifecycle failed",
      })
      const buildFailure = validation.steps.find((step) => step.name === "build" && step.status === "failed")
      if (buildFailure) {
        developerDiagnostics.buildFailures.push({
          stage: "build",
          status: "failed",
          reason: buildFailure.message || validation.failure?.message || "Build failed",
          output: buildFailure.data?.output || null,
        })
      }
      const previewFailure = validation.steps.find((step) => step.name === "runtime-smoke" && step.status === "failed")
      if (previewFailure || validation.previewStatus === "error") {
        developerDiagnostics.previewStartupFailures.push({
          stage: "runtime-smoke",
          status: "failed",
          reason: previewFailure?.message || validation.failure?.message || "Preview startup failed",
        })
      }
    }
    await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    traceExecution(traceContext, "build_finished", {
      projectId: input.projectId,
      ok: validation.ok,
      failure: validation.failure || null,
    })
    recordValidationResult(validation.ok, {
      jobId: input.jobId,
      projectId: input.projectId,
      failureStep: validation.failure?.step || null,
    })
    for (const step of validation.steps) {
      if (step.name === "build") {
        recordBuildDuration(step.durationMs, { jobId: input.jobId, projectId: input.projectId, status: step.status })
        warnIfSlow("build", step.durationMs, { jobId: input.jobId, projectId: input.projectId })
      }
    }
    const verificationCommands = await Promise.all(
      (["lint", "typecheck", "build", "preview validation"] as const)
        .map((command) => tools.runCommand(command))
    )
    lastBuildOutputSignature = commandOutputSignature(verificationCommands)
    buildLogs = [
      ...buildLogs,
      ...verificationCommands.map((item) => {
        const output = [item.stdout, item.stderr].filter(Boolean).join("\n")
        return `${item.command}:${item.success ? "passed" : "failed"}:${item.exitCode}${output ? `:${output}` : ""}`
      }),
    ].slice(-60)
    log("info", "build_output", {
      jobId: input.jobId,
      projectId: input.projectId,
      iteration: 1,
      ok: validation.ok,
      commands: verificationCommands,
      failure: validation.failure || null,
    })
    log("info", "agent_verify", {
      jobId: input.jobId,
      projectId: input.projectId,
      iteration: 1,
      ok: validation.ok,
      steps: validation.steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
      })),
      failure: validation.failure || null,
    })
    if (!validation.ok) {
      updateAiTask(input.jobId, {
        validatorFailures: [validation.failure?.message || "Validation failed"],
      })
      lastErrorSignature = validationErrorSignature(validation)
      const contextMemoryEntry: AgentWorkflowMemoryEntry = {
        iteration: 1,
        changedFiles: plan.actionPlan.map((action) => action.file),
        errors: [{
          step: validation.failure?.step,
          message: validation.failure?.message || "Validation failed",
        }],
        fixes: [],
      }
      workflowMemory.push(contextMemoryEntry)
      log("info", "agent_context_updated", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration: 1,
        memory: contextMemoryEntry,
      })
    }

    while (!validation.ok && repairAttempt < MAX_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      recordRetry({ jobId: input.jobId, projectId: input.projectId, phase: "repair", repairAttempt })
      traceExecution(traceContext, "repair_retry", {
        projectId: input.projectId,
        repairAttempt,
        failure: validation.failure,
      })
      recordRepairStageTelemetry({
        context: traceContext,
        stage: validation.failure?.step || "validation",
        attempt: repairAttempt,
        status: "started",
        meta: {
          projectId: input.projectId,
          failure: validation.failure,
        },
      })
      const iteration = repairAttempt + 1
      await GenerationJobService.update(input.jobId, {
        usedAutoRepair: true,
      })
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      const repairTargets = pickFailingFiles(validation.files, buildDependencyMap(validation.files), validation.failure?.message || "")
      const repairObservation = observeAgentContext({
        prompt: input.prompt,
        plan,
        files: validation.files,
        buildLogs,
        previousAttempts: workflowMemory,
        targetPaths: repairTargets.map((file) => file.path),
      })
      log("info", "agent_observe", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        ...summarizeAgentObservation(repairObservation),
      })
      const repairActions = repairTargets.map((file): AgentWorkflowAction => ({
        action: "modify",
        file: normalizePath(file.path),
        reason: validation?.failure?.message || "Validation failure repair target",
      }))
      log("info", "agent_plan", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        tasks: ["read error log", "repair failing files", "rerun verification"],
        actions: repairActions,
      })
      log("info", "repair_iteration", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        repairAttempt,
        maxIterations: MAX_AGENT_ITERATIONS,
        failure: validation.failure,
        targetFiles: repairActions.map((action) => action.file),
      })
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
      await appendOrchestrationEvent({
        jobId: input.jobId,
        trace: {
          traceId: correlation.traceId,
          workerId: null,
        },
        type: "repair_started",
        stage: "repairing",
        status: "running",
        message: `Repair attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS} started`,
        data: {
          repairAttempt,
          maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
          failure: validation.failure,
          targetFiles: repairActions.map((action) => action.file),
        },
      })
      await OrchestrationRuntimeService.startRepairAttempt({
        jobId: input.jobId,
        attempt: repairAttempt,
        trace: {
          traceId: correlation.traceId,
          workerId: null,
        },
        reason: validation.failure?.message || "Validation lifecycle failed",
        input: {
          targetFiles: repairActions.map((action) => action.file),
          failure: validation.failure,
        },
        idempotencyKey: `repair:${input.jobId}:${repairAttempt}`,
        metadata: {
          maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
          steps: validation.steps,
        },
      }).catch(() => null)
      appendRepairPath(plan.orchestration, {
        attempt: repairAttempt,
        reason: validation.failure?.message || "Validation lifecycle failed",
        targetFiles: repairActions.map((action) => action.file),
      })
      developerDiagnostics.repairPath = plan.orchestration.repairPath
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      developerDiagnostics.repairAttempts.push({
        attempt: repairAttempt,
        reason: validation.failure?.message || "Validation lifecycle failed",
        targetFiles: repairActions.map((action) => action.file),
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "REPAIRING",
        status: "started",
        reason: validation.failure?.message || "Repair loop started",
        repairAttempt,
        data: {
          targetFiles: repairActions.map((action) => action.file),
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)

      const previousRepairFiles = validation.files
      const previousValidation = validation
      const previousRepairScore = repairScore(previousValidation)
      const previousRepairFileHash = hashGeneratedFiles(previousRepairFiles)
      const repaired = await attemptTargetedRepair({
        jobId: input.jobId,
        projectId: input.projectId,
        prompt: input.prompt,
        files: validation.files,
        plan,
        blueprint,
        editPlan: plan.editPlan,
        validationError: validation.failure?.message || "Validation lifecycle failed",
        repairAttempt,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
        promptLanguage,
        observation: repairObservation,
        signal: input.signal,
      })

      assertNotAborted(input.signal)
      workingFiles = repaired.files
      const repairDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === repairAttempt)
      if (repairDiagnostic) {
        repairDiagnostic.repairPromptPreview = repaired.repairPromptPreview
        repairDiagnostic.repairedArtifactSummary = repaired.repairedArtifactSummary
        repairDiagnostic.failedBecause =
          repaired.acceptedFileCount === 0 || !repaired.repaired
            ? "No accepted repaired files"
            : undefined
      }
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "REPAIRING",
        status: repaired.repaired ? "passed" : "failed",
        reason: repaired.repaired ? "Repair artifact accepted" : repaired.failureMessage || "Repair artifact produced no accepted file changes",
        repairAttempt,
        data: {
          terminationReason: repaired.terminationReason || null,
          parsedFileCount: repaired.parsedFileCount,
          acceptedFileCount: repaired.acceptedFileCount,
          rejectedFiles: repaired.rejectedFiles,
          deletedPaths: repaired.deletedPaths,
          addedPackages: repaired.addedPackages,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
      const repairedFileHash = hashGeneratedFiles(workingFiles)
      log("info", "repair_result", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        repairAttempt,
        repaired: repaired.repaired,
        parsedFileCount: repaired.parsedFileCount,
        acceptedFileCount: repaired.acceptedFileCount,
        rejectedFiles: repaired.rejectedFiles,
        deletedPaths: repaired.deletedPaths,
        installedDependencies: repaired.installedDependencies,
        addedPackages: repaired.addedPackages,
      })
      log("info", "agent_execute_tools", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        tools: ["readFile", "writeFile", "listFiles", "searchFiles", "runCommand"],
        changedFiles: repaired.files.map((file) => normalizePath(file.path)),
        deletedPaths: repaired.deletedPaths,
        fileCount: tools.listFiles().length,
      })

      if (repaired.acceptedFileCount === 0 || !repaired.repaired || repairedFileHash === previousRepairFileHash) {
        repairStopReason =
          repaired.terminationReason ||
          (repaired.acceptedFileCount === 0 || !repaired.repaired
            ? "empty_repair_output"
            : "repeated_identical_artifact")
        const publicStopReason = publicRepairTerminationReason(repairStopReason)
        log("warn", "repair_stopped", {
          jobId: input.jobId,
          projectId: input.projectId,
          iteration,
          repairAttempt,
          reason: repairStopReason,
          acceptedFileCount: repaired.acceptedFileCount,
          fileHashChanged: repairedFileHash !== previousRepairFileHash,
        })
        await appendOrchestrationEvent({
          jobId: input.jobId,
          trace: {
            traceId: correlation.traceId,
            workerId: null,
          },
          type: "repair_failed",
          stage: "repairing",
          status: "failed",
          message: publicStopReason,
          data: {
            reason: repairStopReason,
            repairAttempts: repairAttempt,
            maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
            lastValidatorError: validation.failure?.step || null,
            lastValidatorMessage: validation.failure?.message || null,
            acceptedFileCount: repaired.acceptedFileCount,
            fileHashChanged: repairedFileHash !== previousRepairFileHash,
          },
        })
        await OrchestrationRuntimeService.finishRepairAttempt({
          jobId: input.jobId,
          attempt: repairAttempt,
          status: "failed",
          terminationReason: repairStopReason,
          validatorError: validation.failure?.step || null,
          output: repaired.repairedArtifactSummary,
          metadata: {
            acceptedFileCount: repaired.acceptedFileCount,
            fileHashChanged: repairedFileHash !== previousRepairFileHash,
          },
        }).catch(() => null)
        recordRepairStageTelemetry({
          context: traceContext,
          stage: validation.failure?.step || "repair",
          attempt: repairAttempt,
          status: "stopped",
          meta: {
            projectId: input.projectId,
            reason: repairStopReason,
            acceptedFileCount: repaired.acceptedFileCount,
            fileHashChanged: repairedFileHash !== previousRepairFileHash,
          },
        })
        workflowMemory.push({
          iteration,
          changedFiles: [],
          errors: [{
            step: validation.failure?.step,
            message: validation.failure?.message || "Validation failed before repair could change files",
          }],
        fixes: [repairStopReason],
      })
        break
      }
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
          deletedPaths: repaired.deletedPaths,
          installedDependencies: repaired.installedDependencies,
          addedPackages: repaired.addedPackages,
          normalizedPackages: repaired.normalizedPackages,
        }
      )
      await emitGeneratedFilesUpdate({
        jobId: input.jobId,
        stage: "repairing",
        message: `Repaired files ${repairAttempt}/${MAX_REPAIR_ATTEMPTS} ready in Explorer`,
        allFiles: workingFiles,
        previousFiles: previousRepairFiles,
        changedFiles: repaired.files,
        deletedPaths: repaired.deletedPaths,
        source: "repair",
        data: {
          repairAttempt,
          repaired: repaired.repaired,
          parsedFileCount: repaired.parsedFileCount,
          acceptedFileCount: repaired.acceptedFileCount,
          rejectedFiles: repaired.rejectedFiles,
          deletedPaths: repaired.deletedPaths,
          installedDependencies: repaired.installedDependencies,
        },
      })

      traceExecution(traceContext, "build_started", {
        projectId: input.projectId,
        repairAttempt,
        fileCount: workingFiles.length,
      })
      validation = await runValidationLifecycle({
        jobId: input.jobId,
        userId: input.userId,
        projectId: input.projectId,
        prompt: input.prompt,
        files: workingFiles,
        plan,
        blueprint,
        trace: {
          traceId: correlation.traceId,
          workerId: null,
        },
        signal: input.signal,
        emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
      })
      const nextRepairScore = repairScore(validation)
      if (nextRepairScore < previousRepairScore) {
        workingFiles = previousRepairFiles
        validation = previousValidation
        repairStopReason = "repair_score_regressed"
        const repairValidationDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === repairAttempt)
        if (repairValidationDiagnostic) {
          repairValidationDiagnostic.failedBecause = "Repair score regressed; candidate discarded"
          repairValidationDiagnostic.validatorResult = {
            status: "failed",
            repairScore: nextRepairScore,
            previousRepairScore,
          }
        }
        await OrchestrationRuntimeService.finishRepairAttempt({
          jobId: input.jobId,
          attempt: repairAttempt,
          status: "failed",
          terminationReason: repairStopReason,
          validatorError: validation.failure?.step || null,
          output: summarizeGeneratedFiles(repaired.files),
          metadata: {
            repairScore: nextRepairScore,
            previousRepairScore,
            discarded: true,
            maxFilesPerRepair: MAX_FILES_PER_REPAIR,
          },
        }).catch(() => null)
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "REPAIRING",
          status: "failed",
          reason: "Repair score regressed; candidate discarded",
          repairAttempt,
          data: {
            repairScore: nextRepairScore,
            previousRepairScore,
            maxFilesPerRepair: MAX_FILES_PER_REPAIR,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        break
      }
      markOrchestrationValidation(plan.orchestration, {
        status: validation.ok ? "passed" : "failed",
        failedScope: validation.failure?.step || "",
        failures: validation.ok ? [] : [validation.failure?.message || "Validation lifecycle failed after repair"],
      })
      markPreviewStatus(plan.orchestration, validation.previewStatus)
      developerDiagnostics.validationStatus = plan.orchestration.validationStatus
      developerDiagnostics.failedScope = plan.orchestration.failedScope
      developerDiagnostics.previewStatus = plan.orchestration.previewStatus
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      const repairValidationDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === repairAttempt)
      if (repairValidationDiagnostic) {
        repairValidationDiagnostic.validatorResult = {
          status: validation.ok ? "passed" : "failed",
          failure: validation.failure || null,
          steps: validation.steps.map((step) => ({
            name: step.name,
            status: step.status,
            policy: step.policy,
            reason: step.message || null,
          })),
        }
        repairValidationDiagnostic.failedBecause = validation.ok ? undefined : validation.failure?.message || "Validation failed after repair"
      }
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: validation.ok ? "STARTING_PREVIEW" : "VALIDATING",
        status: validation.ok ? "passed" : "failed",
        reason: validation.ok ? "Repaired artifacts passed validation" : validation.failure?.message || "Validation failed after repair",
        repairAttempt,
        data: {
          failure: validation.failure || null,
          steps: validation.steps.map((step) => ({
            name: step.name,
            status: step.status,
            policy: step.policy,
            durationMs: step.durationMs,
            reason: step.message || null,
          })),
        },
      })
      if (!validation.ok) {
        developerDiagnostics.validatorFailures.push({
          stage: validation.failure?.step || "validation",
          status: "failed",
          reason: validation.failure?.message || "Validation failed after repair",
          repairAttempt,
        })
        const buildFailure = validation.steps.find((step) => step.name === "build" && step.status === "failed")
        if (buildFailure) {
          developerDiagnostics.buildFailures.push({
            stage: "build",
            status: "failed",
            reason: buildFailure.message || validation.failure?.message || "Build failed after repair",
            repairAttempt,
            output: buildFailure.data?.output || null,
          })
        }
        const previewFailure = validation.steps.find((step) => step.name === "runtime-smoke" && step.status === "failed")
        if (previewFailure || validation.previewStatus === "error") {
          developerDiagnostics.previewStartupFailures.push({
            stage: "runtime-smoke",
            status: "failed",
            reason: previewFailure?.message || validation.failure?.message || "Preview startup failed after repair",
            repairAttempt,
          })
        }
      }
      if (validation.ok) {
        recordRepairStageTelemetry({
          context: traceContext,
          stage: "validation",
          attempt: repairAttempt,
          status: "passed",
          meta: {
            projectId: input.projectId,
          },
        })
        await appendOrchestrationEvent({
          jobId: input.jobId,
          trace: {
            traceId: correlation.traceId,
            workerId: null,
          },
          type: "repair_succeeded",
          stage: "repairing",
          status: "running",
          message: `Repair attempt ${repairAttempt}/${MAX_REPAIR_ATTEMPTS} passed validation`,
          data: {
            repairAttempt,
            repairAttempts: repairAttempt,
            lastValidatorError: null,
          },
        })
        await OrchestrationRuntimeService.finishRepairAttempt({
          jobId: input.jobId,
          attempt: repairAttempt,
          status: "succeeded",
          terminationReason: null,
          validatorError: null,
          output: summarizeGeneratedFiles(workingFiles),
          metadata: {
            validationSteps: validation.steps,
          },
        }).catch(() => null)
      } else {
        recordRepairStageTelemetry({
          context: traceContext,
          stage: validation.failure?.step || "validation",
          attempt: repairAttempt,
          status: "failed",
          meta: {
            projectId: input.projectId,
            failure: validation.failure,
          },
        })
        await OrchestrationRuntimeService.finishRepairAttempt({
          jobId: input.jobId,
          attempt: repairAttempt,
          status: "failed",
          terminationReason: validation.failure?.message || "validation_failed_after_repair",
          validatorError: validation.failure?.step || null,
          output: summarizeGeneratedFiles(workingFiles),
          metadata: {
            validationSteps: validation.steps,
          },
        }).catch(() => null)
      }
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      traceExecution(traceContext, "build_finished", {
        projectId: input.projectId,
        repairAttempt,
        ok: validation.ok,
        failure: validation.failure || null,
      })
      recordValidationResult(validation.ok, {
        jobId: input.jobId,
        projectId: input.projectId,
        repairAttempt,
        failureStep: validation.failure?.step || null,
      })
      for (const step of validation.steps) {
        if (step.name === "build") {
          recordBuildDuration(step.durationMs, { jobId: input.jobId, projectId: input.projectId, status: step.status })
          warnIfSlow("build", step.durationMs, { jobId: input.jobId, projectId: input.projectId, repairAttempt })
        }
      }
      const repairVerificationCommands = await Promise.all(
        (["lint", "typecheck", "build", "preview validation"] as const)
          .map((command) => tools.runCommand(command))
      )
      const currentBuildOutputSignature = commandOutputSignature(repairVerificationCommands)
      const buildOutputUnchanged = currentBuildOutputSignature === lastBuildOutputSignature
      buildLogs = [
        ...buildLogs,
        ...repairVerificationCommands.map((item) => {
          const output = [item.stdout, item.stderr].filter(Boolean).join("\n")
          return `${item.command}:${item.success ? "passed" : "failed"}:${item.exitCode}${output ? `:${output}` : ""}`
        }),
      ].slice(-60)
      log("info", "build_output", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        ok: validation.ok,
        commands: repairVerificationCommands,
        failure: validation.failure || null,
      })
      log("info", "agent_verify", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        ok: validation.ok,
        steps: validation.steps.map((step) => ({
          name: step.name,
          status: step.status,
          policy: step.policy,
        })),
        failure: validation.failure || null,
      })
      const contextMemoryEntry: AgentWorkflowMemoryEntry = {
        iteration,
        changedFiles: repaired.files.map((file) => normalizePath(file.path)),
        errors: validation.ok
          ? []
          : [{
              step: validation.failure?.step,
              message: validation.failure?.message || "Validation failed after repair",
            }],
        fixes: [
          repaired.repaired ? "targeted repair applied" : "repair returned no accepted file changes",
          ...repaired.addedPackages.map((packageName) => `added package ${packageName}`),
          ...repaired.normalizedPackages.map((packageName) => `normalized package ${packageName}`),
        ],
      }
      workflowMemory.push(contextMemoryEntry)
      log("info", "agent_context_updated", {
        jobId: input.jobId,
        projectId: input.projectId,
        iteration,
        memory: contextMemoryEntry,
      })
      if (!validation.ok) {
        const currentErrorSignature = validationErrorSignature(validation)
        if (currentErrorSignature && currentErrorSignature === lastErrorSignature) {
          repairStopReason = "identical_error_repeated"
        } else if (buildOutputUnchanged) {
          repairStopReason = "build_output_unchanged"
        }

        if (repairStopReason) {
          const repairStopDiagnostic = developerDiagnostics.repairAttempts.find((item) => item.attempt === repairAttempt)
          if (repairStopDiagnostic) {
            repairStopDiagnostic.failedBecause = repairStopReason
          }
          markOrchestrationValidation(plan.orchestration, {
            status: "blocked",
            failedScope: validation.failure?.step || "repair",
            failures: [validation.failure?.message || repairStopReason],
          })
          developerDiagnostics.validationStatus = plan.orchestration.validationStatus
          developerDiagnostics.failedScope = plan.orchestration.failedScope
          developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
          recordDeveloperDiagnostic(developerDiagnostics, {
            stage: "REPAIRING",
            status: "failed",
            reason: repairStopReason,
            repairAttempt,
            data: {
              errorSignature: currentErrorSignature,
              buildOutputUnchanged,
            },
          })
          await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
          log("warn", "repair_stopped", {
            jobId: input.jobId,
            projectId: input.projectId,
            iteration,
            repairAttempt,
            reason: repairStopReason,
            errorSignature: currentErrorSignature,
            buildOutputUnchanged,
          })
          break
        }

        lastErrorSignature = currentErrorSignature
      }
      lastBuildOutputSignature = currentBuildOutputSignature
      assertNotAborted(input.signal)
    }

    if (!validation.ok && shouldApplySafePreviewFallback(plan, validation)) {
      await GenerationJobService.assertNotCancelled(input.jobId)
      assertNotAborted(input.signal)
      repairStopReason = repairStopReason || "validator_deadlock"
      markOrchestrationValidation(plan.orchestration, {
        status: "blocked",
        failedScope: validation.failure?.step || "preview-compile",
        failures: [
          validation.failure?.message ||
            "Preview compile failed after targeted repair; broad fallback regeneration is disabled by orchestration policy.",
        ],
      })
      appendRepairPath(plan.orchestration, {
        attempt: repairAttempt + 1,
        reason:
          validation.failure?.message ||
          "Preview compile failed after targeted repair; broad fallback regeneration is disabled by orchestration policy.",
        targetFiles: pickFailingFiles(validation.files, buildDependencyMap(validation.files), validation.failure?.message || "")
          .map((file) => normalizePath(file.path))
          .slice(0, 8),
        failedScope: validation.failure?.step || "preview-compile",
        issueType: "tsx_build",
        fixPlan: "automatic broad fallback is blocked; human review or architecture correction is required",
      })
      developerDiagnostics.repairPath = plan.orchestration.repairPath
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      developerDiagnostics.validationStatus = plan.orchestration.validationStatus
      developerDiagnostics.failedScope = plan.orchestration.failedScope
      developerDiagnostics.repairAttempts.push({
        attempt: repairAttempt + 1,
        reason:
          validation.failure?.message ||
          "Preview compile failed after targeted repair; broad fallback regeneration is disabled by orchestration policy.",
        targetFiles: plan.orchestration.repairPath.at(-1)?.targetFiles || [],
        failedBecause: "Broad fallback regeneration disabled by orchestration policy",
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "REPAIRING",
        status: "failed",
        reason: "Automatic broad fallback blocked by orchestration policy",
        repairAttempt: repairAttempt + 1,
        data: {
          failure: validation.failure || null,
          repairStopReason,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    }

    workingFiles = validation.files
    const generatedFilesManifest = summarizeGeneratedManifest(workingFiles)
    const completedBlueprintValidation = validateBlueprintConstraints(workingFiles, blueprint, {
      requiredFiles:
        plan.productionMode === "production_fullstack" || plan.editPlan.mode === "partial"
          ? plan.filePlan.map((file) => file.path)
          : plan.blueprint.requiredFiles,
    })
    log("info", "generation_manifest_completed", {
      jobId: input.jobId,
      projectId: input.projectId,
      classification: plan.productionMode,
      promptClassification: plan.objective,
      productionMode: plan.productionMode,
      fileCount: generatedFilesManifest.length,
      generatedFiles: generatedFilesManifest,
      requiredFilesMissing: completedBlueprintValidation.missingRequiredFiles,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "generation.manifest.completed",
      stage: "validating",
      status: "running",
      message: "Generated artifact manifest completed",
      data: {
        classification: plan.productionMode,
        promptClassification: plan.objective,
        productionMode: plan.productionMode,
        fileCount: generatedFilesManifest.length,
        generatedFiles: generatedFilesManifest,
        requiredFilesMissing: completedBlueprintValidation.missingRequiredFiles,
        appPlan,
      },
    })
    metrics.previewStatus = validation.previewStatus
    metrics.previewError = validation.failure?.message || null
    metrics.validationLifecycle = {
      ok: validation.ok,
      repairAttempts: repairAttempt,
      steps: validation.steps,
      sandboxValidation: validation.sandboxValidation,
      failure: validation.failure || null,
    }
    metrics.agentWorkflow = {
      maxIterations: MAX_AGENT_ITERATIONS,
      completedIterations: Math.min(MAX_AGENT_ITERATIONS, repairAttempt + 1),
      tasks: plan.agentTasks,
      actionPlan: plan.actionPlan,
      memory: workflowMemory,
      buildLogs: buildLogs.slice(-20),
    }
    metrics.quality = {
      appType: plan.appType,
      intent: intentStorageKey(plan.intent),
      usedAutoRepair: repairAttempt > 0,
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
      const fallback = buildMinimalRunnableFallbackProject({
        files: workingFiles,
        plan,
        reason: validation.failure?.message || "Validation failed after repair loop",
        replaceCore: true,
      })
      if (fallback.injectedPaths.length > 0) {
        await GenerationJobService.assertNotCancelled(input.jobId)
        assertNotAborted(input.signal)
        workingFiles = fallback.files
        tools = createAgentWorkflowTools(workingFiles, { projectId: input.projectId, signal: input.signal })
        repairStopReason = null
        log("warn", "minimal_runnable_fallback_before_failure", {
          jobId: input.jobId,
          projectId: input.projectId,
          reason: fallback.reason,
          injectedPaths: fallback.injectedPaths,
          missingBefore: fallback.missingBefore,
          fileCount: workingFiles.length,
        })
        await appendOrchestrationEvent({
          jobId: input.jobId,
          trace: {
            traceId: correlation.traceId,
            workerId: null,
          },
          type: "minimal_fallback_injected",
          stage: "repairing",
          status: "running",
          message: "Minimal runnable fallback project injected before final failure",
          data: {
            reason: fallback.reason,
            injectedPaths: fallback.injectedPaths,
            missingBefore: fallback.missingBefore,
            fileCount: workingFiles.length,
          },
        })
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: "REPAIRING",
          status: "passed",
          reason: "Minimal runnable fallback injected before final failure",
          data: {
            previousFailure: validation.failure || null,
            injectedPaths: fallback.injectedPaths,
            fileCount: workingFiles.length,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        validation = await runValidationLifecycle({
          jobId: input.jobId,
          userId: input.userId,
          projectId: input.projectId,
          prompt: input.prompt,
          files: workingFiles,
          plan,
          blueprint,
          trace: {
            traceId: correlation.traceId,
            workerId: null,
          },
          signal: input.signal,
          emit: (stage, label, progress, data) => transition(input.jobId, stage, label, progress, data),
        })
        markOrchestrationValidation(plan.orchestration, {
          status: validation.ok ? "passed" : "failed",
          failedScope: validation.failure?.step || "",
          failures: validation.ok ? [] : [validation.failure?.message || "Minimal fallback validation failed"],
        })
        markPreviewStatus(plan.orchestration, validation.previewStatus)
        developerDiagnostics.validationStatus = plan.orchestration.validationStatus
        developerDiagnostics.failedScope = plan.orchestration.failedScope
        developerDiagnostics.previewStatus = plan.orchestration.previewStatus
        developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
        recordDeveloperDiagnostic(developerDiagnostics, {
          stage: validation.ok ? "STARTING_PREVIEW" : "VALIDATING",
          status: validation.ok ? "passed" : "failed",
          reason: validation.ok ? "Minimal fallback project passed validation" : validation.failure?.message || "Minimal fallback validation failed",
          data: {
            fallbackInjectedPaths: fallback.injectedPaths,
            steps: validation.steps.map((step) => ({
              name: step.name,
              status: step.status,
              policy: step.policy,
              durationMs: step.durationMs,
              reason: step.message || null,
            })),
            failure: validation.failure || null,
          },
        })
        await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
        metrics.validationLifecycle = {
          ok: validation.ok,
          repairAttempts: repairAttempt,
          steps: validation.steps,
          sandboxValidation: validation.sandboxValidation,
          failure: validation.failure || null,
        }
        metrics.previewStatus = validation.previewStatus
        metrics.previewError = validation.failure?.message || null
      }
    }

    if (!validation.ok) {
      repairStopReason =
        repairStopReason ||
        classifyRepairTerminationReason({
          repairAttempt,
          maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
          validation,
        }) ||
        "validator_deadlock"
      const finalRepairReason = publicRepairTerminationReason(repairStopReason)
      await appendOrchestrationEvent({
        jobId: input.jobId,
        trace: {
          traceId: correlation.traceId,
          workerId: null,
        },
        type: "repair_failed",
        stage: "repairing",
        status: "failed",
        message: finalRepairReason,
        data: {
          reason: repairStopReason,
          repairAttempts: repairAttempt,
          maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
          lastValidatorError: validation.failure?.step || null,
          lastValidatorMessage: validation.failure?.message || null,
        },
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "FAILED",
        status: "failed",
        reason: finalRepairReason,
        data: {
          repairAttempts: repairAttempt,
          repairTerminationReason: repairStopReason,
          failure: validation.failure || null,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      log("warn", "Generation validation lifecycle failed", {
        jobId: input.jobId,
        projectId: input.projectId,
        repairAttempts: repairAttempt,
        failure: validation.failure,
      })
      throw new Error(validation.failure?.message || finalRepairReason)
    }
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: "READY",
      status: "passed",
      reason: "Generation validated and ready to persist",
      data: {
        fileCount: workingFiles.length,
        repairAttempts: repairAttempt,
        previewStatus: validation.previewStatus,
      },
    })
    await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
    updateAiTask(input.jobId, {
      filesChanged: workingFiles.map((file) => normalizePath(file.path)),
      repairAttempts: repairAttempt,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      modelUsed: input.selectedModel,
      dependenciesAdded: extractPackageNames(workingFiles),
    })

    assertCompileGatePassed(validation)
    await GenerationJobService.assertNotCancelled(input.jobId)
    assertNotAborted(input.signal)
    await transition(input.jobId, "persisting", "Persisting validated project artifacts", 94, {
      repairAttempts: repairAttempt,
      validationSteps: validation.steps.map((step) => ({
        name: step.name,
        status: step.status,
        policy: step.policy,
      })),
    })

    const persistenceStartedAt = Date.now()
    markCommitStatus(plan.orchestration, "pending")
    developerDiagnostics.commitStatus = plan.orchestration.commitStatus
    const finalProjectMemory = buildPersistentArchitectureSnapshot({
      files: workingFiles,
      intent: plan.structuredIntent,
      architecturePlan: plan.architecture,
      previousMemoryJson,
    })
    const finalDependencyGraph = buildArchitectureDependencyGraph({
      intent: plan.structuredIntent,
      architecturePlan: plan.architecture,
      memory: finalProjectMemory,
    })
    const saveResult = await ProjectFilePersistenceService.saveBufferedArtifacts({
      projectId: input.projectId,
      prompt: input.prompt,
      files: workingFiles,
      projectMemoryJson: JSON.stringify({
        ...finalProjectMemory,
        dependencyGraph: finalDependencyGraph,
        architectureSnapshot: finalProjectMemory,
        projectState: buildPersistedProjectStateSnapshot({
          files: workingFiles,
          validation,
        }),
      }),
      idempotencyKey: input.persistenceKey,
      generationJobId: input.jobId,
      intent: intentStorageKey(plan.intent),
      usedAutoRepair: repairAttempt > 0,
    })
    const persistenceEndedAt = Date.now()
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "architecture_snapshot_persisted",
      stage: "persisting",
      status: "running",
      message: "Architecture graph snapshot persisted after generation",
      data: {
        snapshotId: finalProjectMemory.snapshotId,
        routeCount: finalProjectMemory.routeGraph.length,
        componentCount: finalProjectMemory.componentGraph.length,
        serviceCount: finalProjectMemory.serviceGraph.length,
        apiCount: finalProjectMemory.apiGraph.length,
        dependencyCount: finalProjectMemory.dependencies.reduce((sum, item) => sum + item.imports.length, 0),
      },
    })
    await transition(input.jobId, "persisting", "Committing verified project state", 96, {
      historyId: saveResult.historyId,
      generatedFileCount: workingFiles.length,
      committedFileCount: saveResult.files.length,
    })
    const commitDiagnostics = await verifyProjectStateCommit({
      projectId: input.projectId,
      historyId: saveResult.historyId,
      generatedFiles: workingFiles,
      plan,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "project_state_committed",
      stage: "persisting",
      status: "running",
      message: "Project state committed and verified",
      data: commitDiagnostics,
    })
    const postGenerationAudit = auditPostGeneration({
      plan,
      generatedFiles: workingFiles,
      persistedFiles: await ProjectFilesystemService.readFiles(input.projectId),
      previewUrl: validation.previewUrl,
      previewStatus: validation.previewStatus,
    })
    metrics.postGenerationAudit = postGenerationAudit
    if (!postGenerationAudit.ok) {
      markCommitStatus(plan.orchestration, "failed")
      markOrchestrationValidation(plan.orchestration, {
        status: "failed",
        failedScope: "post-generation-audit",
        failures: postGenerationAudit.failures,
      })
      appendRepairPath(plan.orchestration, {
        attempt: plan.orchestration.repairCount + 1,
        reason: `Post-generation audit failed: ${postGenerationAudit.failures.join("; ")}`,
        targetFiles: postGenerationAudit.requiredFiles.filter(
          (file) => !saveResult.files.some((savedFile) => normalizePath(savedFile.path) === file)
        ),
        failedScope: "post-generation-audit",
        issueType: "architecture_mismatch",
        fixPlan: "repair only missing persisted route/component scope; do not full-regenerate",
      })
      developerDiagnostics.validationStatus = plan.orchestration.validationStatus
      developerDiagnostics.failedScope = plan.orchestration.failedScope
      developerDiagnostics.repairPath = plan.orchestration.repairPath
      developerDiagnostics.commitStatus = plan.orchestration.commitStatus
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
      developerDiagnostics.validatorFailures.push({
        stage: "post-generation-audit",
        status: "failed",
        reason: "Post-generation audit failed before success",
        failures: postGenerationAudit.failures,
      })
      recordDeveloperDiagnostic(developerDiagnostics, {
        stage: "FAILED",
        status: "failed",
        reason: "Post-generation audit failed before success",
        data: {
          audit: postGenerationAudit,
        },
      })
      await updateDeveloperDiagnostics(input.jobId, developerDiagnostics)
      await GenerationJobService.update(input.jobId, {
        diagnostics: {
          developer: developerDiagnostics,
          orchestrationSummary: {
            event: "post_generation_audit_failed",
            stage: "post-generation-audit",
            reason: postGenerationAudit.failures.join("; "),
            repairAttempts: repairAttempt,
          },
        },
        metrics,
      })
      throw new Error(`Post-generation audit failed: ${postGenerationAudit.failures.join("; ")}`)
    }
    markCommitStatus(plan.orchestration, "persisted")
    developerDiagnostics.commitStatus = plan.orchestration.commitStatus
    developerDiagnostics.previewStatus = plan.orchestration.previewStatus
    developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
    log("info", "database_persisted", {
      event: "database_persisted",
      jobId: input.jobId,
      projectId: input.projectId,
      startedAt: new Date(persistenceStartedAt).toISOString(),
      endedAt: new Date(persistenceEndedAt).toISOString(),
      durationMs: persistenceEndedAt - persistenceStartedAt,
      historyId: saveResult.historyId,
      fileCount: saveResult.files.length,
      committedFileCount: commitDiagnostics.committedFileCount,
      failedWritePaths: commitDiagnostics.failedWritePaths,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
      persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
    })
    log("info", "generation_files_persisted", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      fileCount: saveResult.files.length,
      committedFileCount: commitDiagnostics.committedFileCount,
      failedWritePaths: commitDiagnostics.failedWritePaths,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
      persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
    })
    log("info", "files_written", {
      event: "files_written",
      jobId: input.jobId,
      projectId: input.projectId,
      startedAt: new Date(persistenceStartedAt).toISOString(),
      endedAt: new Date(persistenceEndedAt).toISOString(),
      durationMs: persistenceEndedAt - persistenceStartedAt,
      historyId: saveResult.historyId,
      fileCount: saveResult.files.length,
      committedFileCount: commitDiagnostics.committedFileCount,
      failedWritePaths: commitDiagnostics.failedWritePaths,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
      persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "job.files.persisted",
      stage: "persisting",
      status: "running",
      message: "Project filesystem persisted",
      data: {
        event: "database_persisted",
        source: "persisted",
        historyId: saveResult.historyId,
        startedAt: new Date(persistenceStartedAt).toISOString(),
        endedAt: new Date(persistenceEndedAt).toISOString(),
        durationMs: persistenceEndedAt - persistenceStartedAt,
        fileCount: saveResult.files.length,
        committedFileCount: commitDiagnostics.committedFileCount,
        failedWritePaths: commitDiagnostics.failedWritePaths,
        fileDiff: saveResult.fileDiff,
        manifest: saveResult.manifest,
        persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
      },
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "files_written",
      stage: "persisting",
      status: "running",
      message: "Files written to project filesystem",
      data: {
        event: "files_written",
        source: "persisted",
        historyId: saveResult.historyId,
        startedAt: new Date(persistenceStartedAt).toISOString(),
        endedAt: new Date(persistenceEndedAt).toISOString(),
        durationMs: persistenceEndedAt - persistenceStartedAt,
        fileCount: saveResult.files.length,
        committedFileCount: commitDiagnostics.committedFileCount,
        failedWritePaths: commitDiagnostics.failedWritePaths,
        fileDiff: saveResult.fileDiff,
        manifest: saveResult.manifest,
        persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
      },
    })

    assertNotAborted(input.signal)
    metrics.persistence = {
      historyId: saveResult.historyId,
      fileDiff: saveResult.fileDiff,
      manifest: saveResult.manifest,
      verifiedFileCount: commitDiagnostics.committedFileCount,
      commitDiagnostics,
      postGenerationAudit,
      commitStatus: plan.orchestration.commitStatus,
    }
    metrics.componentRegistry = analyzeComponentRegistryUsage(workingFiles, (metrics.intentTemplate as { id?: string } | null)?.id || null)
    metrics.componentGenerationAnalytics = (metrics.componentRegistry as { componentGenerationAnalytics?: unknown }).componentGenerationAnalytics || null
    await GenerationJobService.update(input.jobId, {
      metrics,
      intent: intentStorageKey(plan.intent),
      usedAutoRepair: repairAttempt > 0,
      previewUrl: validation.previewUrl,
    })
    log("info", "preview_ready", {
      jobId: input.jobId,
      projectId: input.projectId,
      historyId: saveResult.historyId,
      previewUrl: validation.previewUrl,
      previewStatus: validation.previewStatus,
      fileCount: commitDiagnostics.committedFileCount,
      generatedFileCount: commitDiagnostics.generatedFileCount,
      persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
    })
    await GenerationJobService.appendEvent({
      jobId: input.jobId,
      type: "preview_ready",
      stage: "completed",
      status: "running",
      message: "Preview artifacts ready",
      data: {
        previewUrl: validation.previewUrl,
        historyId: saveResult.historyId,
        fileCount: commitDiagnostics.committedFileCount,
        generatedFileCount: commitDiagnostics.generatedFileCount,
        persistedSnapshotId: commitDiagnostics.persistedSnapshotId,
        previewStatus: validation.previewStatus,
      },
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
        componentRegistry: analyzeComponentRegistryUsage(workingFiles, intentTemplate?.id || null),
        componentGenerationAnalytics: (metrics.componentRegistry as { componentGenerationAnalytics?: unknown }).componentGenerationAnalytics || null,
        agentWorkflow: {
          maxIterations: MAX_AGENT_ITERATIONS,
          completedIterations: Math.min(MAX_AGENT_ITERATIONS, repairAttempt + 1),
          tasks: plan.agentTasks,
          actionPlan: plan.actionPlan,
          memory: workflowMemory,
        },
      },
    })
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: {
        traceId: correlation.traceId,
        workerId: null,
      },
      type: "generation_completed",
      stage: "completed",
      status: "completed",
      message: "Generation completed",
      data: {
        event: "generation_completed",
        stage: "completed",
        reason: "Generation validated, persisted, and preview artifacts are ready",
        repairAttempts: repairAttempt,
        lastSuccessfulStage: developerDiagnostics.lastSuccessfulStage || "READY",
        previewUrl: validation.previewUrl,
        persistence: commitDiagnostics,
        lastValidatorError: null,
      },
    })
    await GenerationJobService.markCompleted(input.jobId, saveResult.historyId, validation.previewUrl)
    traceExecution(traceContext, "task_completed", {
      projectId: input.projectId,
      historyId: saveResult.historyId,
      durationMs: Math.round(performance.now() - jobStartedAt),
      repairAttempts: repairAttempt,
      tokenUsage: { promptTokens, completionTokens, totalTokens },
    })

    return {
      historyId: saveResult.historyId,
      files: workingFiles,
      previewUrl: validation.previewUrl,
    }
  } catch (error) {
    traceError(traceContext, error, {
      projectId: input.projectId,
      repairAttempts: repairAttempt,
      durationMs: Math.round(performance.now() - jobStartedAt),
    })
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
    const publicErrorMessage = publicGenerationErrorMessage(error)
    const repairTerminationReason =
      repairStopReason ||
      classifyRepairTerminationReason({
        error,
        repairAttempt,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
        validation,
      })
    const orchestrationFailureReason = repairTerminationReason
      ? publicRepairTerminationReason(repairTerminationReason)
      : serialized.message
    const runtimeFailure =
      validation?.failure?.step === "runtime-smoke"
        ? {
            ...(() => {
              const diagnostics = extractRuntimeFailureDiagnostics(validation.failure.message, validation.failure.data as Record<string, unknown> | undefined)
              const runtimeCategory = categorizeRuntimeFailure(
                diagnostics,
                validation.failure.message,
                validation.failure.data as Record<string, unknown> | undefined
              )
              return {
                runtimeCategory,
                renderingCategory: runtimeCategory === "rendering_failed"
                  ? categorizeRenderingFailure(
                      diagnostics,
                      validation.failure.message,
                      validation.failure.data as Record<string, unknown> | undefined
                    )
                  : null,
                renderScore: renderScore(validation),
              }
            })(),
          }
        : null
    const failedComponentRegistry = validation?.files
      ? analyzeComponentRegistryUsage(validation.files, (metrics.intentTemplate as { id?: string } | null)?.id || null)
      : null
    if (plan) {
      if (/persist|database|filesystem|save|commit/i.test(serialized.message)) {
        markCommitStatus(plan.orchestration, "failed")
      }
      developerDiagnostics.allowedScope = plan.orchestration.allowedScope
      developerDiagnostics.rejectedFiles = plan.orchestration.rejectedFiles
      developerDiagnostics.previewStatus = plan.orchestration.previewStatus
      developerDiagnostics.commitStatus = plan.orchestration.commitStatus
      developerDiagnostics.orchestrationDiagnostics = plan.orchestration as unknown as Record<string, unknown>
    }
    recordDeveloperDiagnostic(developerDiagnostics, {
      stage: "FAILED",
      status: "failed",
      reason: orchestrationFailureReason,
      repairAttempt: repairAttempt > 0 ? repairAttempt : undefined,
      data: {
        repairTerminationReason: repairTerminationReason || null,
        publicMessage: publicErrorMessage,
        validationFailure: validation?.failure || null,
        runtimeFailure,
        componentRegistry: failedComponentRegistry,
      },
    })
    const failedArtifactDir = await persistFailedGenerationArtifacts({
      jobId: input.jobId,
      projectId: input.projectId,
      prompt: {
        prompt: input.prompt,
        selectedModel: input.selectedModel,
        collaborationMode: input.collaborationMode || null,
        promptLanguage,
      },
      planner: plan,
      rawOutput: rawOutputs,
      validator: {
        validation,
        diagnostics: developerDiagnostics,
        repairTerminationReason: repairTerminationReason || null,
      },
      buildLog: [
        ...buildLogs,
        ...validationLogLines(validation, "build"),
      ],
      runtimeLog: validationLogLines(validation, "runtime"),
    }).catch((artifactError) => {
      log("warn", "failed_generation_artifact_storage_failed", {
        jobId: input.jobId,
        projectId: input.projectId,
        error: artifactError instanceof Error ? artifactError.message : String(artifactError),
      })
      return null
    })
    await GenerationJobService.update(input.jobId, {
      diagnostics: {
        ...serialized,
        publicMessage: publicErrorMessage,
        orchestrationSummary: {
          event: "generation_failed",
          stage: developerDiagnostics.currentStage,
          reason: orchestrationFailureReason,
          repairAttempts: repairAttempt,
          lastValidatorError: validation?.failure?.step || null,
          lastValidatorMessage: validation?.failure?.message || null,
          lastSuccessfulStage: developerDiagnostics.lastSuccessfulStage || null,
          repairTerminationReason: repairTerminationReason || null,
          failedArtifactDir,
          runtimeFailure,
          componentRegistry: failedComponentRegistry,
        },
        failedArtifactDir,
        developer: developerDiagnostics,
        providerAttempts:
          error instanceof SwiftProviderFailureError
            ? error.attempts
            : undefined,
      },
      metrics,
      ...(plan ? { intent: intentStorageKey(plan.intent), usedAutoRepair: repairAttempt > 0 } : {}),
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
        publicErrorMessage,
        runtimeFailure,
        componentRegistry: failedComponentRegistry,
        editPlan: plan
          ? {
              mode: plan.editPlan.mode,
              intent: plan.editPlan.intent,
              targetPaths: plan.editPlan.targetPaths,
              allowedNewPaths: plan.editPlan.allowedNewPaths,
            }
          : null,
        agentWorkflow: plan
          ? {
              maxIterations: MAX_AGENT_ITERATIONS,
              completedIterations: Math.min(MAX_AGENT_ITERATIONS, repairAttempt + 1),
              tasks: plan.agentTasks,
              actionPlan: plan.actionPlan,
              memory: workflowMemory,
              buildLogs: buildLogs.slice(-20),
            }
          : null,
      },
    }).catch(() => null)
    await appendOrchestrationEvent({
      jobId: input.jobId,
      trace: {
        traceId: correlation.traceId,
        workerId: null,
      },
      type: "generation_failed",
      stage: "failed",
      status: "failed",
      message: publicErrorMessage,
      data: {
        event: "generation_failed",
        stage: developerDiagnostics.currentStage,
        reason: orchestrationFailureReason,
        repairAttempts: repairAttempt,
        lastValidatorError: validation?.failure?.step || null,
        lastValidatorMessage: validation?.failure?.message || null,
        lastSuccessfulStage: developerDiagnostics.lastSuccessfulStage || null,
        repairTerminationReason: repairTerminationReason || null,
      },
    })
    await GenerationJobService.markFailed(input.jobId, publicErrorMessage)
    throw error
  }
}
