import { createHash } from "node:crypto"
import path from "node:path"
import { buildDependencyMap, collectInstallableDependencies, PACKAGE_VERSION_ALLOWLIST } from "@/lib/ai/generation-pipeline"
import { buildImportGraph } from "@/lib/ai/import-graph"
import { writeJsonReport, ensureReportDirectory } from "@/lib/runtime/report-storage"
import type { ControlledAppBlueprint } from "@/lib/ai/app-blueprints"
import type { GeneratedFile } from "@/lib/types"

export type GenerationPhaseName =
  | "prompt_analysis"
  | "blueprint_selection"
  | "scope_reconciliation"
  | "artifact_filtering"
  | "dependency_extraction"
  | "package_synthesis"
  | "automated_repair"
  | "runtime_validation"

export type GenerationPhaseDiagnostic = {
  phase: GenerationPhaseName
  start: string
  end: string | null
  durationMs: number
  warnings: string[]
  hardFailures: string[]
}

export type GenerationPhaseDiagnostics = Record<GenerationPhaseName, GenerationPhaseDiagnostic>

export type GenerationSnapshotInput = {
  jobId: string
  projectId: string
  prompt: string
  blueprint: Record<string, unknown>
  allowedScope: string[]
  expandedScope: string[]
  generatedFiles: GeneratedFile[]
  rejectedArtifacts: Array<Record<string, unknown>>
  detectedDependencies: Array<Record<string, unknown>>
  finalPackageJson: Record<string, unknown> | null
  runtimeFlags: Record<string, unknown>
  diagnostics: Record<string, unknown>
  replay: Record<string, unknown>
}

export type AutomatedRepairDiagnostics = {
  repairAttempts: number
  repairSuccesses: number
  repairFailures: number
  repairedArtifacts: Array<Record<string, unknown>>
  repairedDependencies: string[]
  downgradedCapabilities: string[]
  blockedRepairs: Array<Record<string, unknown>>
  invariantRechecks: Array<Record<string, unknown>>
  repairActions: Array<Record<string, unknown>>
  beforeStateHash: string
  afterStateHash: string
  failedRepairs: Array<Record<string, unknown>>
}

export type GenerationInvariantFailure = {
  category: "hard" | "soft"
  code: string
  message: string
  file?: string
  detail?: Record<string, unknown>
}

export type GenerationInvariantResult = {
  ok: boolean
  hardFailures: GenerationInvariantFailure[]
  warnings: GenerationInvariantFailure[]
  dependencyDiagnostics: {
    blueprintDependencies: string[]
    scannedDependencies: string[]
    mergedDependencies: string[]
    missingDependencies: string[]
    rejectedDependencies: Array<Record<string, unknown>>
  }
}

const PHASES: GenerationPhaseName[] = [
  "prompt_analysis",
  "blueprint_selection",
  "scope_reconciliation",
  "artifact_filtering",
  "dependency_extraction",
  "package_synthesis",
  "automated_repair",
  "runtime_validation",
]

const FORBIDDEN_PATH_RE = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage)(\/|$)|(^|\/)\.env($|\.)|(^|\/)package-lock\.json$/i
const FORBIDDEN_RUNTIME_WRITE_RE = /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|mkdir(?:Sync)?|createWriteStream)\s*\([^)]*["'](?:\/var\/task|\.swift-reports|\.next|node_modules|package-lock\.json)/i
const UNSAFE_EXECUTION_RE = /\b(?:eval|new\s+Function|child_process|execSync|spawnSync|execFileSync|spawn\s*\(|exec\s*\(|curl\s+|wget\s+|postinstall|coinhive|xmrig)\b/i
const CREDENTIAL_LEAK_RE = /\b(?:OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|NEXTAUTH_SECRET|process\.env\.[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD))\b/

// Dependency source of truth, in precedence order:
// 1. Blueprint-required runtime files and capabilities.
// 2. Runtime feature flags inferred from final artifacts (Prisma/Auth/API).
// 3. Generated imports from the final transitive artifact set.
// 4. Explicit system/task-graph dependency declarations.
// Blueprint-required dependencies are asserted even if import scanning misses them.

export function createGenerationPhaseDiagnostics(): GenerationPhaseDiagnostics {
  const now = stableNow()
  const diagnostics = {} as GenerationPhaseDiagnostics
  for (const phase of PHASES) {
    diagnostics[phase] = {
      phase,
      start: now,
      end: null,
      durationMs: 0,
      warnings: [],
      hardFailures: [],
    }
  }
  return diagnostics
}

export function completeGenerationPhase(
  diagnostics: GenerationPhaseDiagnostics,
  phase: GenerationPhaseName,
  input?: {
    warnings?: string[]
    hardFailures?: string[]
  }
) {
  const current = diagnostics[phase]
  const end = stableNow()
  diagnostics[phase] = {
    ...current,
    end,
    durationMs: stableDurationMs(current.start, end),
    warnings: stableUnique([...(current.warnings || []), ...(input?.warnings || [])]),
    hardFailures: stableUnique([...(current.hardFailures || []), ...(input?.hardFailures || [])]),
  }
}

export function assertGenerationInvariants(input: {
  files: GeneratedFile[]
  blueprint: ControlledAppBlueprint
  allowedScope: string[]
  expandedScope?: string[]
  authActive?: boolean
  prismaActive?: boolean
}) {
  const files = stableFiles(input.files)
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const packageJson = parsePackageJson(files)
  const dependencyScan = collectInstallableDependencies({ files })
  const blueprintDependencies = dependenciesForBlueprint(input.blueprint, {
    paths,
    authActive: input.authActive,
    prismaActive: input.prismaActive,
  })
  const scannedDependencies = stableUnique(dependencyScan.sources.map((source) => source.packageName))
  const mergedDependencies = stableUnique([
    ...Object.keys(packageJson.dependencies),
    ...Object.keys(packageJson.devDependencies),
    ...scannedDependencies,
    ...blueprintDependencies,
  ])
  const hardFailures: GenerationInvariantFailure[] = []
  const warnings: GenerationInvariantFailure[] = []

  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (!isSafeGeneratedPath(normalized)) {
      hardFailures.push({
        category: "hard",
        code: "forbidden_path_access",
        message: `Forbidden generated path: ${normalized}`,
        file: normalized,
      })
    }
    if (FORBIDDEN_PATH_RE.test(normalized)) {
      hardFailures.push({
        category: "hard",
        code: "invalid_runtime_assumption",
        message: `Generated file targets runtime-managed path: ${normalized}`,
        file: normalized,
      })
    }
    const content = String(file.content || "")
    if (FORBIDDEN_RUNTIME_WRITE_RE.test(content)) {
      hardFailures.push({
        category: "hard",
        code: "invalid_runtime_assumption",
        message: `${normalized} writes to a forbidden runtime filesystem path.`,
        file: normalized,
      })
    }
    if (UNSAFE_EXECUTION_RE.test(content)) {
      hardFailures.push({
        category: "hard",
        code: "forbidden_execution",
        message: `${normalized} contains forbidden dynamic execution or shell access.`,
        file: normalized,
      })
    }
    if (CREDENTIAL_LEAK_RE.test(content)) {
      hardFailures.push({
        category: "hard",
        code: "credential_leakage",
        message: `${normalized} references sensitive runtime credentials directly.`,
        file: normalized,
      })
    }
  }

  const dependencyMap = buildDependencyMap(files)
  for (const missing of dependencyMap.missingLocalImports) {
    hardFailures.push({
      category: "hard",
      code: "unresolved_import",
      message: `${missing.file} imports unresolved module ${missing.specifier}`,
      file: missing.file,
      detail: { candidates: missing.candidates.slice().sort() },
    })
  }

  const allManifestDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const missingDependencies = blueprintDependencies.filter((dependency) => !allManifestDeps[dependency]).sort()
  for (const dependency of missingDependencies) {
    hardFailures.push({
      category: "hard",
      code: "missing_blueprint_dependency",
      message: `Missing blueprint dependency: ${dependency}`,
      detail: { dependency },
    })
  }

  const prismaActive = input.prismaActive || paths.has("prisma/schema.prisma") || scannedDependencies.includes("@prisma/client")
  if (prismaActive && !paths.has("prisma/schema.prisma")) {
    hardFailures.push({
      category: "hard",
      code: "missing_prisma_schema",
      message: "Prisma is active but prisma/schema.prisma is missing.",
    })
  }

  const authActive = input.authActive || scannedDependencies.includes("next-auth")
  if (authActive && !hasNextAuthConfig(files)) {
    hardFailures.push({
      category: "hard",
      code: "invalid_auth_configuration",
      message: "NextAuth is active but no auth configuration file or auth route exists.",
    })
  }

  const optionalUnused = scannedDependencies.filter((dependency) => !PACKAGE_VERSION_ALLOWLIST[dependency])
  for (const dependency of optionalUnused) {
    warnings.push({
      category: "soft",
      code: "optional_dependency_unused",
      message: `Optional or unsupported dependency ignored: ${dependency}`,
      detail: { dependency },
    })
  }

  return {
    ok: hardFailures.length === 0,
    hardFailures: sortFailures(hardFailures),
    warnings: sortFailures(warnings),
    dependencyDiagnostics: {
      blueprintDependencies,
      scannedDependencies,
      mergedDependencies,
      missingDependencies,
      rejectedDependencies: dependencyScan.rejected
        .map((item) => stableRecord(item))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    },
  } satisfies GenerationInvariantResult
}

export function runDeterministicAutomatedRepair(input: {
  files: GeneratedFile[]
  blueprint: ControlledAppBlueprint
  allowedScope: string[]
  expandedScope?: string[]
  authActive?: boolean
  prismaActive?: boolean
}): {
  files: GeneratedFile[]
  diagnostics: AutomatedRepairDiagnostics
  invariants: GenerationInvariantResult
} {
  let files = stableFiles(input.files)
  const beforeStateHash = stableHash(summarizeFiles(files))
  const diagnostics: AutomatedRepairDiagnostics = {
    repairAttempts: 0,
    repairSuccesses: 0,
    repairFailures: 0,
    repairedArtifacts: [],
    repairedDependencies: [],
    downgradedCapabilities: [],
    blockedRepairs: [],
    invariantRechecks: [],
    repairActions: [],
    beforeStateHash,
    afterStateHash: beforeStateHash,
    failedRepairs: [],
  }

  let invariants = assertGenerationInvariants({
    files,
    blueprint: input.blueprint,
    allowedScope: input.allowedScope,
    expandedScope: input.expandedScope,
    authActive: input.authActive,
    prismaActive: input.prismaActive,
  })
  diagnostics.invariantRechecks.push(summarizeInvariantRecheck("before", invariants))

  const missingAllowedDependencies = invariants.dependencyDiagnostics.missingDependencies
    .filter((dependency) => PACKAGE_VERSION_ALLOWLIST[dependency])
    .sort()
  if (missingAllowedDependencies.length > 0) {
    diagnostics.repairAttempts += 1
    const repaired = synthesizePackageJson(files, {
      injectDependencies: missingAllowedDependencies,
      reason: "required_by_blueprint",
    })
    files = repaired.files
    diagnostics.repairSuccesses += repaired.changed ? 1 : 0
    diagnostics.repairedDependencies.push(...repaired.injected)
    diagnostics.repairActions.push(
      ...repaired.injected.map((dependency) => ({
        type: "dependency_injection",
        dependency,
        reason: "required_by_blueprint",
      }))
    )
  }

  const runtimeNormalization = normalizeRuntimeFilesystem(files)
  if (runtimeNormalization.changed) {
    diagnostics.repairAttempts += 1
    files = runtimeNormalization.files
    diagnostics.repairSuccesses += 1
    diagnostics.repairedArtifacts.push(...runtimeNormalization.changedFiles.map((filePath) => ({
      type: "runtime_filesystem_normalization",
      file: filePath,
      reason: "forbidden_runtime_path",
    })))
    diagnostics.repairActions.push(...runtimeNormalization.changedFiles.map((filePath) => ({
      type: "runtime_filesystem_normalization",
      file: filePath,
      reason: "forbidden_runtime_path",
    })))
  }

  const prismaDowngrade = maybeDowngradePrisma(files, input.blueprint)
  if (prismaDowngrade.changed) {
    diagnostics.repairAttempts += 1
    files = prismaDowngrade.files
    diagnostics.repairSuccesses += 1
    diagnostics.downgradedCapabilities.push("prisma")
    diagnostics.repairActions.push({
      type: "prisma_capability_downgrade",
      reason: prismaDowngrade.reason,
      removedDependencies: prismaDowngrade.removedDependencies,
    })
  } else if (prismaDowngrade.blocked) {
    diagnostics.blockedRepairs.push({
      type: "prisma_capability_downgrade",
      reason: prismaDowngrade.reason,
    })
  }

  const authRepair = reconcileNextAuth(files)
  if (authRepair.changed) {
    diagnostics.repairAttempts += 1
    files = authRepair.files
    diagnostics.repairSuccesses += 1
    diagnostics.repairedDependencies.push(...authRepair.injected)
    diagnostics.repairActions.push(...authRepair.injected.map((dependency) => ({
      type: "auth_dependency_reconciliation",
      dependency,
      reason: "next_auth_artifact_detected",
    })))
  }

  files = synthesizePackageJson(files, { injectDependencies: [], reason: "stable_sort" }).files
  invariants = assertGenerationInvariants({
    files,
    blueprint: input.blueprint,
    allowedScope: input.allowedScope,
    expandedScope: input.expandedScope,
    authActive: input.authActive,
    prismaActive: input.prismaActive,
  })
  diagnostics.invariantRechecks.push(summarizeInvariantRecheck("after", invariants))

  const unrepairable = invariants.hardFailures.filter((failure) =>
    ["forbidden_execution", "credential_leakage", "unresolved_import", "invalid_auth_configuration"].includes(failure.code)
  )
  if (unrepairable.length > 0) {
    diagnostics.repairFailures += unrepairable.length
    diagnostics.failedRepairs.push(...unrepairable.map((failure) => ({
      type: failure.code,
      file: failure.file || null,
      reason: failure.message,
    })))
    diagnostics.blockedRepairs.push(...unrepairable.map((failure) => ({
      type: failure.code,
      file: failure.file || null,
      reason: "unsafe_or_ambiguous_repair",
    })))
  }

  diagnostics.repairedDependencies = stableUnique(diagnostics.repairedDependencies)
  diagnostics.downgradedCapabilities = stableUnique(diagnostics.downgradedCapabilities)
  diagnostics.afterStateHash = stableHash(summarizeFiles(files))

  return {
    files,
    diagnostics,
    invariants,
  }
}

export async function persistGenerationSnapshot(input: GenerationSnapshotInput) {
  const dir = await ensureReportDirectory("generation-snapshots", input.jobId)
  const replayDir = await ensureReportDirectory("generation-replay", input.jobId)
  const snapshotPayload = stableRecord({
    mode: "swift_generation_snapshot_v1",
    prompt: sanitizeText(input.prompt, 20_000),
    blueprint: input.blueprint,
    allowedScope: stableUnique(input.allowedScope.map(normalizePath)),
    expandedScope: stableUnique(input.expandedScope.map(normalizePath)),
    generatedFiles: summarizeFiles(input.generatedFiles),
    rejectedArtifacts: input.rejectedArtifacts.map(stableRecord),
    detectedDependencies: input.detectedDependencies.map(stableRecord),
    finalPackageJson: input.finalPackageJson ? stableRecord(input.finalPackageJson) : null,
    runtimeFlags: stableRecord(input.runtimeFlags),
    diagnostics: stableSnapshotDiagnostics(input.diagnostics),
  })
  const replayPayload = stableRecord({
    mode: "swift_generation_replay_v1",
    prompt: sanitizeText(input.prompt, 20_000),
    blueprint: input.blueprint,
    taskGraph: input.replay.taskGraph || null,
    scopeReconciliation: input.replay.scopeReconciliation || null,
    packageSynthesis: input.replay.packageSynthesis || null,
    repairActions: input.replay.repairActions || [],
    beforeStateHash: input.replay.beforeStateHash || "",
    afterStateHash: input.replay.afterStateHash || "",
    downgradedCapabilities: input.replay.downgradedCapabilities || [],
    invariantRechecks: input.replay.invariantRechecks || [],
    blockedRepairs: input.replay.blockedRepairs || [],
    failedRepairs: input.replay.failedRepairs || [],
  })
  const snapshotHash = stableHash(snapshotPayload)
  const replayHash = stableHash(replayPayload)

  await writeJsonReport(path.join(dir, "snapshot.json"), {
    metadata: {
      jobId: input.jobId,
      projectId: input.projectId,
      capturedAt: new Date().toISOString(),
    },
    snapshot: snapshotPayload,
    snapshotHash,
  })
  await writeJsonReport(path.join(replayDir, "replay.json"), {
    metadata: {
      jobId: input.jobId,
      projectId: input.projectId,
      capturedAt: new Date().toISOString(),
    },
    replay: replayPayload,
    replayHash,
  })

  return {
    snapshotPath: path.join(dir, "snapshot.json"),
    replayPath: path.join(replayDir, "replay.json"),
    snapshotHash,
    replayHash,
  }
}

export function parsePackageJson(files: GeneratedFile[]) {
  const file = files.find((item) => normalizePath(item.path) === "package.json")
  if (!file) {
    return {
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: "package.json missing",
      raw: null as Record<string, unknown> | null,
    }
  }

  try {
    const parsed = JSON.parse(String(file.content || "{}")) as Record<string, unknown>
    return {
      dependencies: stableStringRecord(parsed.dependencies),
      devDependencies: stableStringRecord(parsed.devDependencies),
      parseError: null as string | null,
      raw: stableRecord(parsed),
    }
  } catch (error) {
    return {
      dependencies: {} as Record<string, string>,
      devDependencies: {} as Record<string, string>,
      parseError: error instanceof Error ? error.message : String(error),
      raw: null as Record<string, unknown> | null,
    }
  }
}

export function stableFiles(files: GeneratedFile[]) {
  return files
    .map((file) => ({
      path: normalizePath(file.path),
      language: file.language,
      content: String(file.content || ""),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function stableHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

function synthesizePackageJson(
  files: GeneratedFile[],
  input: {
    injectDependencies: string[]
    reason: string
  }
) {
  const packageJson = parsePackageJson(files)
  const raw = packageJson.raw || {
    name: "swift-generated-app",
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
    },
  }
  const dependencies = stableStringRecord((raw as Record<string, unknown>).dependencies)
  const devDependencies = stableStringRecord((raw as Record<string, unknown>).devDependencies)
  const peerDependencies = stableStringRecord((raw as Record<string, unknown>).peerDependencies)
  const optionalDependencies = stableStringRecord((raw as Record<string, unknown>).optionalDependencies)
  const injected: string[] = []

  for (const dependency of input.injectDependencies.slice().sort()) {
    const version = PACKAGE_VERSION_ALLOWLIST[dependency]
    if (!version) continue
    const target = isDevDependency(dependency) ? devDependencies : dependencies
    const otherTarget = isDevDependency(dependency) ? dependencies : devDependencies
    delete otherTarget[dependency]
    if (!target[dependency]) {
      target[dependency] = version
      injected.push(dependency)
    }
  }

  const nextPackageJson = stableRecord({
    ...raw,
    scripts: stableStringRecord((raw as Record<string, unknown>).scripts),
    dependencies: sortPackageRecord(dependencies),
    devDependencies: sortPackageRecord(devDependencies),
    peerDependencies: sortPackageRecord(peerDependencies),
    optionalDependencies: sortPackageRecord(optionalDependencies),
  }) as Record<string, unknown>
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (Object.keys((nextPackageJson[section] as Record<string, string>) || {}).length === 0) {
      delete nextPackageJson[section]
    }
  }

  const packageFile: GeneratedFile = {
    path: "package.json",
    language: "json",
    content: `${JSON.stringify(nextPackageJson, null, 2)}\n`,
  }
  const output = stableFiles(files).filter((file) => normalizePath(file.path) !== "package.json")

  return {
    files: [...output, packageFile].sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path))),
    injected: injected.sort(),
    changed: injected.length > 0 || packageJson.raw ? stableHash(packageJson.raw) !== stableHash(nextPackageJson) : true,
    reason: input.reason,
  }
}

function normalizeRuntimeFilesystem(files: GeneratedFile[]) {
  const changedFiles: string[] = []
  const nextFiles = stableFiles(files).map((file) => {
    const normalizedPath = normalizePath(file.path)
    let content = String(file.content || "")
    const original = content
    content = content
      .replace(/["']\/var\/task\/swift-reports["']/g, "getReportStoragePath()")
      .replace(/["']\.swift-reports["']/g, "getReportStoragePath()")
      .replace(/process\.cwd\(\)\s*,\s*["']\.swift-reports["']/g, "getReportStoragePath()")
    if (content !== original) {
      changedFiles.push(normalizedPath)
    }
    return { ...file, content }
  })

  return {
    files: nextFiles,
    changed: changedFiles.length > 0,
    changedFiles: changedFiles.sort(),
  }
}

function maybeDowngradePrisma(files: GeneratedFile[], blueprint: ControlledAppBlueprint) {
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  const packageJson = parsePackageJson(files)
  const hasPrismaDependency = Boolean(packageJson.dependencies["@prisma/client"] || packageJson.devDependencies.prisma)
  const blueprintRequiresSchema = blueprint.requiredFiles.map(normalizePath).includes("prisma/schema.prisma")
  const hasSchema = paths.has("prisma/schema.prisma")

  if (!hasPrismaDependency || hasSchema) {
    return { files, changed: false, blocked: false, reason: "not_applicable", removedDependencies: [] as string[] }
  }
  if (blueprintRequiresSchema) {
    return { files, changed: false, blocked: true, reason: "blueprint_requires_prisma_schema", removedDependencies: [] as string[] }
  }

  const raw = packageJson.raw || {}
  const dependencies = stableStringRecord(raw.dependencies)
  const devDependencies = stableStringRecord(raw.devDependencies)
  const removedDependencies = ["@prisma/client", "prisma"].filter((dependency) => dependencies[dependency] || devDependencies[dependency])
  delete dependencies["@prisma/client"]
  delete devDependencies.prisma

  const nextPackageJson = stableRecord({
    ...raw,
    dependencies: sortPackageRecord(dependencies),
    devDependencies: sortPackageRecord(devDependencies),
  }) as Record<string, unknown>
  for (const section of ["dependencies", "devDependencies"]) {
    if (Object.keys((nextPackageJson[section] as Record<string, string>) || {}).length === 0) delete nextPackageJson[section]
  }

  const nextFiles = stableFiles(files)
    .filter((file) => !/\b@prisma\/client\b/.test(String(file.content || "")))
    .filter((file) => normalizePath(file.path) !== "prisma/schema.prisma")
    .filter((file) => normalizePath(file.path) !== "package.json")
  nextFiles.push({
    path: "package.json",
    language: "json",
    content: `${JSON.stringify(nextPackageJson, null, 2)}\n`,
  })

  return {
    files: nextFiles.sort((left, right) => normalizePath(left.path).localeCompare(normalizePath(right.path))),
    changed: removedDependencies.length > 0,
    blocked: false,
    reason: "prisma_dependency_without_schema",
    removedDependencies: removedDependencies.sort(),
  }
}

function reconcileNextAuth(files: GeneratedFile[]) {
  const hasAuthArtifact = stableFiles(files).some((file) =>
    /\bnext-auth\b|NextAuth\s*\(/.test(`${file.path}\n${file.content}`)
  )
  if (!hasAuthArtifact) {
    return { files, changed: false, injected: [] as string[] }
  }
  const repaired = synthesizePackageJson(files, {
    injectDependencies: ["next-auth"],
    reason: "next_auth_artifact_detected",
  })
  return {
    files: repaired.files,
    changed: repaired.injected.length > 0,
    injected: repaired.injected,
  }
}

function summarizeInvariantRecheck(stage: "before" | "after", invariants: GenerationInvariantResult) {
  return stableRecord({
    stage,
    ok: invariants.ok,
    hardFailureCodes: invariants.hardFailures.map((failure) => failure.code).sort(),
    warningCodes: invariants.warnings.map((warning) => warning.code).sort(),
    missingDependencies: invariants.dependencyDiagnostics.missingDependencies,
  })
}

function sortPackageRecord(record: Record<string, string>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}

function isDevDependency(dependency: string) {
  return ["@tailwindcss/postcss", "@types/node", "@types/react", "@types/react-dom", "autoprefixer", "postcss", "prisma", "tailwindcss", "typescript"].includes(dependency)
}

function dependenciesForBlueprint(
  blueprint: ControlledAppBlueprint,
  input: { paths: Set<string>; authActive?: boolean; prismaActive?: boolean }
) {
  const required = new Set(["next", "react", "react-dom", "typescript"])
  const hasPrisma = input.prismaActive || input.paths.has("prisma/schema.prisma")
  const hasAuth =
    input.authActive ||
    input.paths.has("auth.ts") ||
    Array.from(input.paths).some((filePath) => filePath.startsWith("app/api/auth/"))
  const blueprintRequiredPaths = new Set(blueprint.requiredFiles.map(normalizePath))

  if (hasPrisma || blueprintRequiredPaths.has("prisma/schema.prisma")) {
    required.add("@prisma/client")
    required.add("prisma")
  }
  if (hasAuth || blueprintRequiredPaths.has("app/api/auth/route.ts")) {
    required.add("next-auth")
  }
  if (Array.from(input.paths).some((filePath) => filePath.startsWith("app/api/"))) {
    required.add("zod")
  }

  return stableUnique(Array.from(required))
}

function hasNextAuthConfig(files: GeneratedFile[]) {
  const paths = new Set(files.map((file) => normalizePath(file.path)))
  if (paths.has("auth.ts")) return true
  if (paths.has("lib/auth.ts") || paths.has("lib/auth/config.ts")) return true
  if (Array.from(paths).some((filePath) => filePath.startsWith("app/api/auth/"))) return true
  return files.some((file) => /NextAuth\s*\(|from\s+["']next-auth/.test(String(file.content || "")))
}

function isSafeGeneratedPath(filePath: string) {
  if (!filePath || path.posix.isAbsolute(filePath)) return false
  if (filePath.split("/").includes("..")) return false
  if (/^[a-zA-Z]:/.test(filePath)) return false
  return true
}

function summarizeFiles(files: GeneratedFile[]) {
  const graph = buildImportGraph(files)
  return stableFiles(files).map((file) => ({
    path: file.path,
    language: file.language || null,
    bytes: Buffer.byteLength(file.content, "utf8"),
    sha256: stableHash(file.content),
    imports: (graph.byFile.get(file.path)?.imports || [])
      .map((edge) => ({
        specifier: edge.specifier,
        kind: edge.kind,
        resolvedPath: edge.resolvedPath || null,
        packageName: edge.packageName || null,
      }))
      .sort((left, right) => `${left.kind}:${left.specifier}`.localeCompare(`${right.kind}:${right.specifier}`)),
  }))
}

function sortFailures<T extends { code: string; message: string; file?: string }>(items: T[]) {
  return items
    .map((item) => stableRecord(item) as T)
    .sort((left, right) => `${left.code}:${left.file || ""}:${left.message}`.localeCompare(`${right.code}:${right.file || ""}:${right.message}`))
}

function stableStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim().length > 0)
      .map(([key, recordValue]) => [key.trim(), recordValue.trim()])
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function stableRecord<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stableRecord(item)) as T
  }
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableRecord(item)])
  ) as T
}

function stableSnapshotDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSnapshotDiagnostics)
  }
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(start|end|at|capturedAt|checkedAt|startedAt|completedAt|updatedAt|createdAt)$/i.test(key))
      .filter(([key]) => !/(durationMs|latencyMs|elapsedMs)$/i.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (key === "phases" && item && typeof item === "object" && !Array.isArray(item)) {
          return [
            key,
            Object.fromEntries(
              Object.entries(item as Record<string, GenerationPhaseDiagnostic>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([phase, diagnostic]) => [
                  phase,
                  {
                    phase: diagnostic.phase,
                    warnings: stableUnique(diagnostic.warnings || []),
                    hardFailures: stableUnique(diagnostic.hardFailures || []),
                    status: diagnostic.hardFailures?.length ? "failed" : "completed",
                  },
                ])
            ),
          ]
        }
        return [key, stableSnapshotDiagnostics(item)]
      })
  )
}

function stableStringify(value: unknown) {
  return JSON.stringify(stableRecord(value))
}

function stableUnique(values: string[]) {
  return Array.from(new Set(values.map((item) => String(item || "").trim()).filter(Boolean))).sort()
}

function stableNow() {
  return new Date().toISOString()
}

function stableDurationMs(start: string, end: string) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime())
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function sanitizeText(value: string, maxLength: number) {
  const text = String(value || "")
  const redacted = text
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<redacted>")
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...<truncated:${redacted.length - maxLength}>` : redacted
}
