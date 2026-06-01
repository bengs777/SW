const fs = require("fs")
const path = require("path")

const root = process.cwd()

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[regression] ${name} failed${detail ? `: ${detail}` : ""}`)
  }

  console.log(`[regression] ${name} passed`)
}

const sandboxPreview = read("components/editor/sandbox-preview.tsx")
const generationOrchestrator = read("lib/services/generation-orchestrator.service.ts")
const sandboxRuntime = read("lib/sandbox/runtime.ts")
const generationJobService = read("lib/services/generation-job.service.ts")
const generationJobStream = read("app/api/generate/jobs/[jobId]/stream/route.ts")
const projectPage = read("app/dashboard/project/[id]/page.tsx")
const projectApi = read("app/api/projects/[id]/route.ts")
const developerDiagnostics = read("lib/ai/developer-diagnostics.ts")
const vercelBuild = read("scripts/vercel-build.js")
const productService = read("lib/services/product.service.ts")
const productApi = read("app/api/products/route.ts")
const dbClient = read("lib/db/client.ts")
const authRuntime = read("lib/auth/runtime.ts")
const authConfig = read("auth.ts")
const adminGuard = read("lib/admin.ts")
const healthApi = read("app/api/health/route.ts")
const workerHealthApi = read("app/api/worker/health/route.ts")
const proxy = read("proxy.ts")
const semanticEdit = read("lib/ai/semantic-edit.ts")
const incrementalEdit = read("lib/ai/incremental-edit.ts")
const projectMemoryGraph = read("lib/ai/project-memory-graph.ts")
const generationWorker = read("lib/workers/generation-worker.ts")
const productionReadiness = read("lib/production/readiness.ts")
const deployReadiness = read("scripts/deploy-readiness.js")
const instrumentation = read("instrumentation.ts")
const generationPipeline = read("lib/ai/generation-pipeline.ts")
const taskGraphExecutor = read("lib/ai/task-graph-executor.ts")
const generationStabilization = read("lib/ai/generation-stabilization.ts")
const prismaSchema = read("prisma/schema.prisma")

assert(
  "runtime repair uses virtual boundary import",
  sandboxPreview.includes('injectVirtualModuleImport(') &&
    sandboxPreview.includes("/@preview/components/swift-safe-error-boundary.tsx"),
  "runtime repair must inject a virtual module specifier, not a raw alias"
)

assert(
  "browser preview loads tailwind runtime",
  sandboxPreview.includes("https://cdn.tailwindcss.com") &&
    sandboxPreview.includes("window.tailwind.config") &&
    /script-src[^"]*https:\/\/cdn\.tailwindcss\.com/.test(sandboxPreview),
  "browser preview must generate Tailwind utility CSS inside the iframe"
)

assert(
  "runtime repair never injects raw safe-boundary alias",
  !/source\s*=\s*['"`]import\s+\{\s*SwiftSafeErrorBoundary\s*\}\s+from\s+["']@\/components\/swift-safe-error-boundary/.test(sandboxPreview),
  "raw @/ safe-boundary import cannot be injected after compileProject"
)

assert(
  "stale boundary is warning before pre-blob",
  /runtime\.stale_error_boundary_warning/.test(sandboxPreview) &&
    /rewriteStaleErrorBoundaryReferences\(path, content, 'pre-transform'\)/.test(sandboxPreview) &&
    /rewriteStaleErrorBoundaryReferences\(path, result\.code, 'post-babel'\)/.test(sandboxPreview) &&
    /assertNoStaleErrorBoundary\(path, code, 'pre-blob'\)/.test(sandboxPreview),
  "stale boundary must be repairable before the final hard assertion"
)

assert(
  "runtime repair telemetry is tagged",
  /repair_source:\s*'runtime'/.test(sandboxPreview),
  "repair telemetry must include repair_source: runtime"
)

assert(
  "raw alias invariant exists after repair",
  /function assertNoRawAliasAfterRepair/.test(sandboxPreview) &&
    /assertNoRawAliasAfterRepair\(path, source,/.test(sandboxPreview),
  "runtime repair must validate that no raw alias remains"
)

assert(
  "post-babel boundary repair precedes alias assertion",
  /var repairedCode = rewriteStaleErrorBoundaryReferences\(path, result\.code, 'post-babel'\);\s*assertNoUnresolvedAlias\(path, repairedCode, 'post-babel:post-repair'\)/.test(sandboxPreview),
  "post-babel generated boundary imports must be repaired before unresolved alias validation"
)

assert(
  "deterministic validation lifecycle exists",
  /async function runValidationLifecycle/.test(generationOrchestrator) &&
    /Normalizing generated artifacts/.test(generationOrchestrator) &&
    /Checking static project invariants/.test(generationOrchestrator) &&
    /Compiling preview module graph/.test(generationOrchestrator) &&
    /Running typecheck, lint, and production build/.test(generationOrchestrator),
  "orchestrator must run normalize -> static validation -> preview compile -> typecheck/lint/build"
)

assert(
  "validation failure blocks persistence",
  /if \(!validation\.ok\)[\s\S]*throw new Error\(validation\.failure\?\.message/.test(generationOrchestrator) &&
    /ProjectFilePersistenceService\.saveBufferedArtifacts/.test(generationOrchestrator) &&
    generationOrchestrator.indexOf("if (!validation.ok)") < generationOrchestrator.indexOf("ProjectFilePersistenceService.saveBufferedArtifacts"),
  "invalid artifacts must fail before saveBufferedArtifacts"
)

assert(
  "explicit fullstack and full frontend modes exist",
    /productionMode:\s*"preview"\s*\|\s*"full_frontend"\s*\|\s*"production_fullstack"/.test(generationOrchestrator) &&
    /FULL_FRONTEND_FILE_LIMIT\s*=\s*18/.test(generationOrchestrator) &&
    /validateFrontendCompleteness/.test(generationOrchestrator) &&
    /shouldUseProductionFullStackMode/.test(generationOrchestrator) &&
    /PRODUCTION_FULLSTACK_FILE_LIMIT\s*=\s*16/.test(generationOrchestrator) &&
    /buildFastClinicFullStackScaffold/.test(generationOrchestrator) &&
    /Production pass budget/.test(generationOrchestrator),
  "website prompts must use full frontend mode while full-stack/admin/database/payment prompts use production mode"
)

assert(
  "production fullstack requires full coverage",
  /plan\.productionMode !== "production_fullstack"\) return false/.test(generationOrchestrator) &&
    /requiresFullStackCoverage && fullstack\.missingCategories/.test(generationOrchestrator),
  "production full-stack mode must require frontend, API, data, and config coverage"
)

assert(
  "full generation batch limit is mode aware",
  /function maxChangedFilesForGenerationSlice/.test(generationOrchestrator) &&
    /plan\.generationMode === "PATCH"/.test(generationOrchestrator) &&
    /plan\.editPlan\.mode === "partial"/.test(generationOrchestrator) &&
    /Math\.max\(MAX_CHANGED_FILES_PER_REQUEST, targetCount, plan\.maxFilesThisPass\)/.test(generationOrchestrator) &&
    /maxChangedFilesForGenerationSlice\(plan, targets\.length\)/.test(generationOrchestrator) &&
    /defaultMaxChangedFilesPerRequest/.test(generationOrchestrator),
  "initial full-stack or full-frontend generation batches must not be blocked by the PATCH-only 5 file cap"
)

assert(
  "repair retry is bounded and revalidated",
  /while \(!validation\.ok && repairAttempt < MAX_REPAIR_ATTEMPTS\)/.test(generationOrchestrator) &&
    /Revalidating repaired artifacts/.test(generationOrchestrator) &&
    /repairAttempt \+= 1/.test(generationOrchestrator),
  "repair loop must be capped and must re-run validation after each repair"
)

assert(
  "sandbox gates typecheck lint and build",
  /npm", \["run", "typecheck"\]/.test(sandboxRuntime) &&
    /npm", \["run", "db:generate"\]/.test(sandboxRuntime) &&
    /SWIFT_SANDBOX_LINT_POLICY/.test(sandboxRuntime) &&
    /npm", \["run", "build"\]/.test(sandboxRuntime) &&
    /policy: "required"[\s\S]*command: "npm run build"/.test(sandboxRuntime),
  "sandbox must typecheck, define lint policy, and require production build before preview"
)

assert(
  "job transitions lock terminal and cancelling states",
  /GENERATION_TERMINAL_STATUSES\.has\(existing\.status\)/.test(generationJobService) &&
    /existing\.cancelRequested/.test(generationJobService) &&
    /requestedStatus !== "cancelled"/.test(generationJobService),
  "late completion/failure must not overwrite terminal or cancellation-locked jobs"
)

assert(
  "developer diagnostics are gated",
  /developerDiagnosticsAllowed/.test(generationJobStream) &&
    /isDeveloperAccount/.test(generationJobStream) &&
    /process\.env\.NODE_ENV !== "production"/.test(generationJobStream) &&
    /send\("developer\.diagnostics"/.test(generationJobStream),
  "developer diagnostics SSE payloads must only be sent to developer/local users"
)

assert(
  "developer diagnostics panel wired",
  /DeveloperDiagnosticsPanel/.test(projectPage) &&
    /developer\.diagnostics/.test(projectPage) &&
    /showDeveloperDiagnostics/.test(projectPage),
  "project UI must expose expandable diagnostics only when developer payloads arrive"
)

assert(
  "repair introspection captures failed artifacts",
  /persistInvalidArtifactReport/.test(generationOrchestrator) &&
    /ensureReportDirectory\("failed-generations"/.test(developerDiagnostics) &&
    /writeJsonReport/.test(developerDiagnostics) &&
    /repairPromptPreview/.test(generationOrchestrator) &&
    /validatorResult/.test(generationOrchestrator),
  "orchestrator must capture invalid artifacts and repair-chain details"
)

assert(
  "builder scope contract blocks implicit helpers",
  /AllowedFileScopeContract/.test(generationOrchestrator) &&
    /APPROVED_FILE_SCOPE_CONTRACT/.test(generationOrchestrator) &&
    /components\/app-shell\.tsx/.test(generationOrchestrator) &&
    /isImplicitHelperFile/.test(generationOrchestrator) &&
    /scopeArtifactToAllowedScope\(parsed, input\.plan\)/.test(generationOrchestrator),
  "builder and repair must share an explicit allowed-file contract and block unapproved helper files"
)

assert(
  "vercel build deploys prisma migrations safely",
  /runPrismaGenerateWithRetry\(\)[\s\S]*runMigrationDeployment\(\)/.test(vercelBuild) &&
    /npx prisma migrate deploy/.test(vercelBuild) &&
    !/npx prisma migrate status/.test(vercelBuild) &&
    /diagnoseDatabaseUrl/.test(vercelBuild) &&
    /isStrictPreflight/.test(vercelBuild) &&
    /engine_binary_failure/.test(vercelBuild) &&
    /schema_parsing_failure/.test(vercelBuild) &&
    /migration_baseline_required/.test(vercelBuild) &&
    /schema compatibility check skipped in local fallback mode/.test(vercelBuild),
  "builds must generate Prisma first, deploy pending migrations, diagnose deploy failures, and skip unavailable DB checks locally"
)

assert(
  "prisma migrations use direct database url",
  /url\s*=\s*env\("DATABASE_URL"\)/.test(prismaSchema) &&
    /directUrl\s*=\s*env\("DIRECT_DATABASE_URL"\)/.test(prismaSchema),
  "Prisma runtime must use pooled DATABASE_URL while migrations/admin commands use DIRECT_DATABASE_URL"
)

assert(
  "final dependency scanner reconciles backend imports",
  /collectInstallableDependencies/.test(generationPipeline) &&
    /IMPORT_SPECIFIER_RE/.test(generationPipeline) &&
    /artifact_signal/.test(generationPipeline) &&
    /@prisma\/client/.test(generationPipeline) &&
    /next-auth/.test(generationPipeline) &&
    /prisma\/schema\.prisma/.test(generationPipeline) &&
    /export function normalizeGeneratedDependencies\(files: GeneratedFile\[\]\)/.test(generationPipeline),
  "dependency extraction must scan final files and artifact signals for Prisma and NextAuth packages"
)

assert(
  "task graph dependency install scans operation content",
  /collectInstallableDependencies/.test(taskGraphExecutor) &&
    /taskGraph,/.test(taskGraphExecutor) &&
    /explicitDependencies:\s*fallbackDependencies/.test(taskGraphExecutor) &&
    /dependencySources\.sources\.map/.test(taskGraphExecutor),
  "task graph dependency installation must read create/modify operation content, not only declared dependency arrays"
)

assert(
  "dependency observability is emitted",
  /dependency_detected/.test(generationOrchestrator) &&
    /dependency_source_file/.test(generationOrchestrator) &&
    /dependency_rejected/.test(generationOrchestrator) &&
    /final_dependency_manifest/.test(generationOrchestrator) &&
    /missing_dependency_diagnostic/.test(generationOrchestrator),
  "generation validation must log detected, rejected, final, and missing dependency diagnostics"
)

assert(
  "generation snapshot and replay are deterministic",
  /persistGenerationSnapshot/.test(generationStabilization) &&
    /snapshotHash\s*=\s*stableHash\(snapshotPayload\)/.test(generationStabilization) &&
    /replayHash\s*=\s*stableHash\(replayPayload\)/.test(generationStabilization) &&
    /stableSnapshotDiagnostics/.test(generationStabilization) &&
    /generation\.snapshot\.persisted/.test(generationOrchestrator),
  "snapshot and replay artifacts must be persisted with stable hashes that exclude runtime metadata"
)

assert(
  "phase diagnostics cover generation lifecycle",
  /prompt_analysis/.test(generationStabilization) &&
    /blueprint_selection/.test(generationStabilization) &&
    /scope_reconciliation/.test(generationStabilization) &&
    /artifact_filtering/.test(generationStabilization) &&
    /dependency_extraction/.test(generationStabilization) &&
    /package_synthesis/.test(generationStabilization) &&
    /automated_repair/.test(generationStabilization) &&
    /runtime_validation/.test(generationStabilization) &&
    /completeGenerationPhase/.test(generationOrchestrator),
  "generation diagnostics must be phase-based with warnings and hard failures"
)

assert(
  "generation invariants hard fail before build persistence",
  /assertGenerationInvariants/.test(generationStabilization) &&
    /missing_blueprint_dependency/.test(generationStabilization) &&
    /unresolved_import/.test(generationStabilization) &&
    /forbidden_path_access/.test(generationStabilization) &&
    /invalid_runtime_assumption/.test(generationStabilization) &&
    /missing_prisma_schema/.test(generationStabilization) &&
    /invalid_auth_configuration/.test(generationStabilization) &&
    /Generation invariant hard failure before persist/.test(generationOrchestrator),
  "hard fail invariants must stop generation before build success or persistence"
)

assert(
  "deterministic ordering guards dependency and file outputs",
  /stableFiles/.test(generationStabilization) &&
    /stableUnique/.test(generationStabilization) &&
    /sort\(\(left, right\)/.test(generationPipeline) &&
    /mergedDependencies/.test(generationStabilization),
  "file traversal, dependency merge, and package synthesis must use stable ordering"
)

assert(
  "automated repair is deterministic and replayable",
  /runDeterministicAutomatedRepair/.test(generationStabilization) &&
    /repairAttempts/.test(generationStabilization) &&
    /repairActions/.test(generationStabilization) &&
    /beforeStateHash/.test(generationStabilization) &&
    /afterStateHash/.test(generationStabilization) &&
    /generation\.automated_repair/.test(generationOrchestrator) &&
    /stabilization\.replay\.repairActions/.test(generationOrchestrator),
  "automated repair must emit stable diagnostics and replay actions"
)

assert(
  "dependency repair preserves blueprint-required packages",
  /dependency_injection/.test(generationStabilization) &&
    /required_by_blueprint/.test(generationStabilization) &&
    /PACKAGE_VERSION_ALLOWLIST\[dependency\]/.test(generationStabilization) &&
    /blueprintDependencies/.test(generationStabilization) &&
    /missingDependencies/.test(generationStabilization),
  "missing blueprint dependencies must be repaired only through allowlisted dependency synthesis"
)

assert(
  "runtime isolation and security scanning are enforced",
  /FORBIDDEN_RUNTIME_WRITE_RE/.test(generationStabilization) &&
    /UNSAFE_EXECUTION_RE/.test(generationStabilization) &&
    /CREDENTIAL_LEAK_RE/.test(generationStabilization) &&
    /forbidden_execution/.test(generationStabilization) &&
    /credential_leakage/.test(generationStabilization) &&
    /runtime_filesystem_normalization/.test(generationStabilization),
  "generated code must reject unsafe execution, credential leakage, and forbidden runtime filesystem assumptions"
)

assert(
  "repair replay artifact captures required repair fields",
  /repairActions: input\.replay\.repairActions/.test(generationStabilization) &&
    /downgradedCapabilities: input\.replay\.downgradedCapabilities/.test(generationStabilization) &&
    /invariantRechecks: input\.replay\.invariantRechecks/.test(generationStabilization) &&
    /blockedRepairs: input\.replay\.blockedRepairs/.test(generationStabilization) &&
    /failedRepairs: input\.replay\.failedRepairs/.test(generationStabilization),
  "replay artifacts must retain repair hashes, actions, downgraded capabilities, rechecks, blocked and failed repairs"
)

assert(
  "performance hardening bounds repair and validation scans",
  /MAX_REPAIR_ITERATIONS\s*=\s*3/.test(generationStabilization) &&
    /validationMemo/.test(generationStabilization) &&
    /scanMemo/.test(generationStabilization) &&
    /validationMemoKey/.test(generationStabilization) &&
    /getMemoizedScans/.test(generationStabilization) &&
    /duplicate_repair_state/.test(generationStabilization) &&
    /state_hash_unchanged_after_repair/.test(generationStabilization) &&
    /scanCacheHit/.test(generationStabilization),
  "repair iterations and repeated scans must be bounded with deterministic memoization"
)

assert(
  "replay serialization is compressed and measured",
  /compressDeterministicPayload/.test(generationStabilization) &&
    /replayPayloadBytes/.test(generationStabilization) &&
    /snapshotPayloadBytes/.test(generationStabilization) &&
    /replaySerializationTimeMs/.test(generationStabilization) &&
    /replayCompressionTimeMs/.test(generationStabilization) &&
    /snapshotCompressedBytes/.test(generationStabilization) &&
    /replayCompressedBytes/.test(generationStabilization) &&
    /compressionRatio/.test(generationStabilization) &&
    /replay_serialization/.test(generationStabilization),
  "snapshot and replay serialization must report payload sizes and deterministic compression timing"
)

assert(
  "early termination and resource budgets are enforced",
  /buildEarlyTermination/.test(generationStabilization) &&
    /terminatedEarly/.test(generationStabilization) &&
    /resource_budget_exceeded/.test(generationStabilization) &&
    /MAX_REPLAY_PAYLOAD_BYTES/.test(generationStabilization) &&
    /MAX_GENERATED_ARTIFACTS/.test(generationStabilization) &&
    /MAX_GENERATED_DEPENDENCIES/.test(generationStabilization) &&
    /MAX_PACKAGE_JSON_BYTES/.test(generationStabilization) &&
    /MAX_ROUTE_FILES/.test(generationStabilization) &&
    /generationComplexityScore/.test(generationStabilization),
  "fatal invariants and resource budget overruns must stop downstream expansion"
)

assert(
  "phase timing observability and prisma preflight policy exist",
  /summarizePhaseTiming/.test(generationStabilization) &&
    /slowestPhase/.test(generationStabilization) &&
    /cumulativeValidationTimeMs/.test(generationStabilization) &&
    /repairOverheadTimeMs/.test(generationStabilization) &&
    /MAX_PRISMA_PREFLIGHT_MS\s*=\s*5000/.test(generationStabilization) &&
    /prismaPreflightPolicy/.test(generationStabilization) &&
    /prismaFallbackTriggered/.test(generationStabilization) &&
    /artifactCount/.test(generationStabilization) &&
    /dependencyCount/.test(generationStabilization) &&
    /cacheHits/.test(generationStabilization) &&
    /cacheMisses/.test(generationStabilization) &&
    /generationTiming/.test(generationOrchestrator),
  "pipeline phases, replay serialization, repair overhead, and Prisma preflight must be timed and bounded"
)

assert(
  "orchestration state persists bounded generation progress",
  /orchestrationPersistenceState/.test(generationOrchestrator) &&
    /currentPhase:\s*"persisting"/.test(generationOrchestrator) &&
    /phaseDurations/.test(generationOrchestrator) &&
    /replayHash:\s*snapshotResult\.replayHash/.test(generationOrchestrator) &&
    /repairIterations:\s*stabilization\.automatedRepair\?\.iterations/.test(generationOrchestrator) &&
    /generationProgress:\s*94/.test(generationOrchestrator),
  "generation job metrics must persist replay hash, phase durations, repair iterations, validation state, and progress"
)

assert(
  "generation commit verifies project reload before success",
  /verifyProjectStateCommit/.test(generationOrchestrator) &&
    /ProjectFilesystemService\.readFiles\(input\.projectId\)/.test(generationOrchestrator) &&
    /project_state_committed/.test(generationOrchestrator) &&
    /Project state commit failed: persisted project state is empty/.test(generationOrchestrator) &&
    /failedWritePaths/.test(generationOrchestrator) &&
    generationOrchestrator.indexOf("verifyProjectStateCommit") < generationOrchestrator.indexOf("preview_ready") &&
    /project_state_empty_after_generation/.test(projectApi),
  "generation must read back persisted files and block preview/completion when project state is empty"
)

assert(
  "production backend blueprint scaffold covers commerce users products",
  /buildMissingBackendBlueprintFiles/.test(generationOrchestrator) &&
    /app\/api\/users\/route\.ts/.test(generationOrchestrator) &&
    /app\/api\/products\/route\.ts/.test(generationOrchestrator) &&
    /lib\/services\/user\.service\.ts/.test(generationOrchestrator) &&
    /lib\/services\/product\.service\.ts/.test(generationOrchestrator) &&
    /ProductSchema/.test(generationOrchestrator) &&
    /UserSchema/.test(generationOrchestrator) &&
    /extractUiMockDataToServices/.test(generationOrchestrator),
  "production full-stack generation must add backend blueprint files and move obvious page product mock data into services"
)

assert(
  "runtime db crud is hardened",
  /getDatabaseRuntimeDiagnostic/.test(dbClient) &&
    /DATABASE_URL is required/.test(dbClient) &&
    /Prisma client is not generated/.test(dbClient) &&
    /createProduct/.test(productService) &&
    /updateProduct/.test(productService) &&
    /deleteProduct/.test(productService) &&
    /listProducts/.test(productService) &&
    /CreateProductSchema/.test(productService) &&
    /requireAdminActorResponse/.test(productApi) &&
    /getDatabaseRuntimeDiagnostic/.test(productApi),
  "product CRUD must use Prisma, zod, admin write guards, and clear DB runtime diagnostics"
)

assert(
  "auth runtime has diagnostics and graceful provider fallback",
  /getAuthRuntimeDiagnostic/.test(authRuntime) &&
    /NEXTAUTH_SECRET/.test(authRuntime) &&
    /GOOGLE_CLIENT_ID/.test(authRuntime) &&
    /GOOGLE_CLIENT_SECRET/.test(authRuntime) &&
    /provider_unavailable/.test(authRuntime) &&
    /createNormalizedAuthError/.test(authRuntime) &&
    /providers:\s*authProviders/.test(authConfig) &&
    /session:\s*\{[\s\S]*strategy:\s*"jwt"/.test(authConfig),
  "Auth.js must expose explicit diagnostics, skip unavailable providers gracefully, and use persistent JWT sessions"
)

assert(
  "server rbac protects privileged operations",
  /getCurrentAuthActor/.test(adminGuard) &&
    /requireRoleResponse/.test(adminGuard) &&
    /requireAdminActorResponse/.test(adminGuard) &&
    /requireDeveloperActorResponse/.test(adminGuard) &&
    /canAccessRole/.test(adminGuard) &&
    /memberships:\s*\{\s*select:\s*\{\s*role:\s*true/.test(adminGuard) &&
    /normalizeAdminEmail\(user\.email\) === normalizeAdminEmail\(env\.devOwnerEmail\)/.test(adminGuard),
  "privileged routes must derive roles from the server database and keep developer access owner-scoped"
)

assert(
  "auth diagnostics are included in health and route protection",
  /checkAuth/.test(healthApi) &&
    /auth:\s*okLabel\(authCheck\)/.test(healthApi) &&
    /authCheck\.status !== "unhealthy"/.test(healthApi) &&
    /"\/api\/products"/.test(proxy) &&
    /AUTH_REQUIRED/.test(proxy),
  "health must report auth runtime state and proxy must protect product API routes"
)

assert(
  "architecture memory persists semantic graph snapshots",
  /routeGraph/.test(projectMemoryGraph) &&
    /componentGraph/.test(projectMemoryGraph) &&
    /serviceGraph/.test(projectMemoryGraph) &&
    /apiGraph/.test(projectMemoryGraph) &&
    /dependencies/.test(projectMemoryGraph) &&
    /snapshotId/.test(projectMemoryGraph) &&
    /buildPersistentArchitectureSnapshot/.test(projectMemoryGraph) &&
    /parseProjectMemoryGraph/.test(projectMemoryGraph) &&
    /previousMemoryJson/.test(generationOrchestrator) &&
    /architecture_snapshot_persisted/.test(generationOrchestrator) &&
    /loadProjectMemoryJson/.test(generationWorker),
  "generation must load prior project memory, persist a graph snapshot, and retain route/component/service/API/dependency diagnostics"
)

assert(
  "semantic scoped edits use ast operations",
  /SemanticEditOperation/.test(semanticEdit) &&
    /rename_component/.test(semanticEdit) &&
    /update_prop/.test(semanticEdit) &&
    /move_hook/.test(semanticEdit) &&
    /modify_metadata/.test(semanticEdit) &&
    /update_route/.test(semanticEdit) &&
    /applyRangeEdits/.test(semanticEdit) &&
    /parseTsxAst/.test(semanticEdit) &&
    /dependencyImpact/.test(semanticEdit) &&
    /routeImpact/.test(semanticEdit) &&
    /componentGraphImpact/.test(semanticEdit) &&
    /applySemanticScopedEdit/.test(incrementalEdit) &&
    /findFirstJsxChildrenInsertionPoint/.test(incrementalEdit),
  "scoped edits must be component/route/import aware and expose impact diagnostics instead of blind text replacement"
)

assert(
  "deployment readiness blocks critical invalid runtime env",
  /getDeploymentRuntimeReadiness/.test(productionReadiness) &&
    /assertDeploymentEnvironmentReady/.test(productionReadiness) &&
    /blockingFailures/.test(productionReadiness) &&
    /degradedServices/.test(productionReadiness) &&
    /missingEnvVars/.test(productionReadiness) &&
    /invalidSecrets/.test(productionReadiness) &&
    /dbConnectivity/.test(productionReadiness) &&
    /migrationMismatch/.test(productionReadiness) &&
    /GENERATION_WORKER_HEARTBEAT/.test(productionReadiness) &&
    /SANDBOX_RUNTIME_HEALTH/.test(productionReadiness) &&
    /workerHeartbeatFresh/.test(productionReadiness) &&
    /AUTH_PROVIDER_HEALTH/.test(productionReadiness) &&
    /deployment_readiness/.test(instrumentation),
  "runtime startup and health must fail closed on critical envs while keeping optional services degraded"
)

assert(
  "deploy readiness cli validates migrations db worker and sandbox",
  /MIGRATION_STATUS/.test(deployReadiness) &&
    /SCHEMA_HEALTH/.test(deployReadiness) &&
    /DB_CONNECTIVITY/.test(deployReadiness) &&
    /GENERATION_WORKER_HEARTBEAT/.test(deployReadiness) &&
    /SANDBOX_RUNTIME_HEALTH/.test(deployReadiness) &&
    /AUTH_PROVIDER_HEALTH/.test(deployReadiness) &&
    /missing env vars/.test(deployReadiness) &&
    /invalid secrets/.test(deployReadiness) &&
    /migration mismatch/.test(deployReadiness),
  "deployment readiness script must expose missing env, invalid secret, migration, DB, worker, sandbox, and auth diagnostics"
)

assert(
  "worker health api exposes runtime service detail",
  /getExternalWorkerRuntimeHealth/.test(workerHealthApi) &&
    /workerService/.test(workerHealthApi) &&
    /workerHeartbeatHealthy/.test(workerHealthApi),
  "worker health route must include both Redis heartbeat and external worker runtime detail"
)

console.log("[regression] all checks passed")
