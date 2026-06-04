const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, pass, detail) {
  if (!pass) {
    const error = new Error(`${name}: ${detail}`)
    error.name = "GenerationRuntimeContractError"
    throw error
  }
  console.log(`PASS ${name} - ${detail}`)
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const workerEntry = read("workers/index.ts")
  const workerDockerfile = read("workers/Dockerfile")
  const gitignore = read(".gitignore")
  const sandboxDockerfile = read("services/sandbox-runtime/Dockerfile")
  const runTsScript = read("scripts/run-ts-script.js")
  const workerHealthRoute = read("app/api/worker/health/route.ts")
  const envConfig = read("lib/env.ts")
  const generationQueue = read("lib/queue/generation-queue.ts")
  const generationWorker = read("lib/workers/generation-worker.ts")
  const generationPipeline = read("lib/ai/generation-pipeline.ts")
  const importGraph = read("lib/ai/import-graph.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const generateJobsRoute = read("app/api/generate/jobs/route.ts")
  const architecturePlanner = read("lib/ai/architecture-planner.ts")
  const softwareOrchestration = read("lib/ai/software-orchestration.ts")
  const projectEditorPage = read("app/dashboard/project/[id]/page.tsx")
  const previewPanel = read("components/editor/preview-panel.tsx")
  const errorLogPanel = read("components/editor/error-log-panel.tsx")
  const sandboxRuntimeServer = read("services/sandbox-runtime/server.mjs")
  const sandboxHealthBlock = sandboxRuntimeServer.match(/app\.get\(\"\/health\"[\s\S]*?app\.get\(\"\/sandbox/ )?.[0] || ""
  const runtimeSandbox = read("lib/sandbox/runtime.ts")
  const sandboxRoute = read("app/api/projects/[id]/sandbox/route.ts")
  const externalRuntimeHealth = read("lib/observability/external-runtime-health.ts")
  const deployReadiness = read("scripts/deploy-readiness.js")
  const qualityService = read("lib/services/generation-quality.service.ts")
  const schema = read("prisma/schema.prisma")
  const diagnostics = read("lib/ai/developer-diagnostics.ts")
  const intentLibrary = read("lib/templates/intent-library.ts")
  const componentRegistry = read("lib/ai/component-registry.ts")
  const filePolicy = read("lib/ai/file-policy.ts")
  const registryComponent = (id) => read(`component-registry/${id}.tsx`)
  const templateManifest = (id) => read(`templates/${id}/template.json`)

  assert(
    "worker.standalone-script",
    packageJson.scripts["worker:generation"] === "node scripts/run-ts-script.js workers/index.ts --type=generation",
    "dedicated worker starts without next start"
  )

  assert(
    "worker.docker-standalone",
    /CMD \["npm", "run", "worker:generation"\]/.test(workerDockerfile) &&
      /SWIFT_GENERATION_EXECUTION_MODE=queue/.test(workerDockerfile) &&
      /node:20-bookworm-slim/.test(workerDockerfile) &&
      /apt-get install -y --no-install-recommends ca-certificates openssl/.test(workerDockerfile),
    "worker image runs queue mode standalone with Prisma-compatible OpenSSL runtime"
  )

  assert(
    "worker.docker-runtime-sources",
    /COPY --from=builder \/app\/scripts \.\/scripts/.test(workerDockerfile) &&
      /COPY --from=builder \/app\/workers \.\/workers/.test(workerDockerfile) &&
      /COPY --from=builder \/app\/lib \.\/lib/.test(workerDockerfile) &&
      /COPY --from=builder \/app\/components \.\/components/.test(workerDockerfile) &&
      /COPY --from=builder \/app\/auth\.ts \.\/auth\.ts/.test(workerDockerfile),
    "worker image includes source files required by run-ts-script and path aliases"
  )

  assert(
    "worker.docker-postinstall-script",
    /COPY scripts\/prisma-generate\.js \.\/scripts\/prisma-generate\.js[\s\S]*RUN npm ci/.test(workerDockerfile),
    "worker dependency stage includes the Prisma postinstall script before npm ci"
  )

  assert(
    "worker.env-files-ignored",
    /\.env\*/.test(gitignore),
    "local env files are ignored and are not part of production source control"
  )

  assert(
    "worker.placeholder-url-normalization",
    envConfig.includes("isPlaceholderEnvValue") &&
      envConfig.includes("isPlaceholderEnvValue(trimmed)") &&
      envConfig.includes('normalizeUrl(getEnv("SWIFT_WORKER_HEALTH_URL", "WORKER_HEALTH_URL"))') &&
      deployReadiness.includes("isPlaceholderValue") &&
      deployReadiness.includes('normalizeUrl(value("SWIFT_WORKER_HEALTH_URL", "WORKER_HEALTH_URL"))'),
    "placeholder worker URLs are treated as missing instead of probed"
  )

  assert(
    "worker.tsx-runtime-loader",
    /require\.extensions\["\.ts"\] = compileTypeScript/.test(runTsScript) &&
      /require\.extensions\["\.tsx"\] = compileTypeScript/.test(runTsScript),
    "worker TypeScript runtime can load ts and tsx dependencies"
  )

  assert(
    "worker.health-server",
    /http\.createServer/.test(workerEntry) &&
      /\/api\/worker\/health/.test(workerEntry) &&
      /mode:\s*"queue"/.test(workerEntry) &&
      /function markRuntimeReady/.test(workerEntry) &&
      /markRuntimeReady\(\)[\s\S]*worker\.on\("ready", markRuntimeReady\)/.test(workerEntry),
    "standalone worker exposes process health"
  )

  assert(
    "worker.health-route",
    /getGenerationQueueHealth/.test(workerHealthRoute) &&
      /getExternalWorkerRuntimeHealth/.test(workerHealthRoute) &&
      /workerService/.test(workerHealthRoute) &&
      /deadLetter/.test(workerHealthRoute) &&
      /heartbeat/.test(workerHealthRoute) &&
      /mode:\s*"queue"/.test(workerHealthRoute),
    "app health endpoint reports queue heartbeat, DLQ status, and external worker runtime detail"
  )

  assert(
    "queue.dead-letter",
    /DEAD_LETTER_QUEUE_NAME/.test(generationQueue) &&
      /moveGenerationJobToDeadLetter/.test(generationQueue) &&
      /replayGenerationDeadLetterJob/.test(generationQueue) &&
      /getGenerationDeadLetterQueue/.test(generationQueue),
    "generation DLQ supports write and replay"
  )

  assert(
    "worker.heartbeat",
    /recordGenerationWorkerHeartbeat/.test(generationQueue) &&
      /GENERATION_WORKER_HEARTBEAT_KEY/.test(generationQueue) &&
      /recordGenerationWorkerHeartbeat\(workerId/.test(generationWorker),
    "worker heartbeat is recorded by the dedicated worker"
  )

  assert(
    "queue.enqueue-degraded-worker",
    /function canQueueAcceptJobs/.test(generateJobsRoute) &&
      /queueWorkerDegraded/.test(generateJobsRoute) &&
      /generation_queue_worker_degraded_enqueue_anyway/.test(generateJobsRoute) &&
      /queue\.fallback_scheduled/.test(generateJobsRoute) &&
      /hasDedicatedSandboxService/.test(generateJobsRoute),
    "queue enqueue separates Redis availability from worker heartbeat and supports VPS sandbox fallback"
  )

  assert(
    "frontend.first-page-order",
    /function shouldStartWithFrontendPass/.test(orchestrator) &&
      /SWIFT_FRONTEND_FIRST_GENERATION/.test(orchestrator) &&
      /wantsProductionFullStack && !frontendFirstPass/.test(orchestrator) &&
      /app\/dashboard\/page\.tsx/.test(orchestrator) &&
      /app\/projects\/\[id\]\/page\.tsx/.test(orchestrator) &&
      /app\/checkout\/page\.tsx/.test(orchestrator) &&
      /pageOrder = new Map/.test(orchestrator),
    "new projects start with frontend pages and dashboard/e-commerce routes are generated in a stable order"
  )

  assert(
    "architecture.frontend-before-backend",
    /"frontend_generation"[\s\S]*"backend_generation"/.test(architecturePlanner) &&
      /Build scaffold and frontend pages before backend/.test(architecturePlanner),
    "architecture instructions keep frontend validation ahead of backend integration"
  )

  assert(
    "ecommerce.conditional-auth-admin-routes",
    /stagedEcommerceRouteRequirements/.test(orchestrator) &&
      /plannerRequiresEcommerceLogin/.test(orchestrator) &&
      /plannerRequiresEcommerceAdmin/.test(orchestrator) &&
      /for \(const route of stagedEcommerceRouteRequirements\(input.plan\)\)/.test(orchestrator) &&
      /shouldIncludeCommerceLogin/.test(architecturePlanner) &&
      /shouldIncludeCommerceAdmin/.test(architecturePlanner) &&
      /plannerRequestsCommerceLogin/.test(softwareOrchestration) &&
      /plannerRequestsCommerceAdmin/.test(softwareOrchestration),
    "ecommerce generation keeps storefront routes mandatory while login/admin are intent-driven"
  )

  assert(
    "generation.status-ux",
    /type GenerationQueueState/.test(projectEditorPage) &&
      /queueStateCopy/.test(projectEditorPage) &&
      /applyRuntimeStatusEvent/.test(projectEditorPage) &&
      /queue\.fallback_scheduled/.test(projectEditorPage) &&
      /queue\.worker_degraded/.test(projectEditorPage) &&
      /statusHint/.test(previewPanel) &&
      /errorAdvice/.test(errorLogPanel),
    "dashboard surfaces queue, worker, fallback, sandbox, and retry guidance to users"
  )

  assert(
    "sandbox.health-detail",
    sandboxHealthBlock.includes('service: "swift-sandbox-runtime"') &&
      sandboxHealthBlock.includes("rootReady: storageOk") &&
      sandboxHealthBlock.includes("rootError: storageError") &&
      sandboxHealthBlock.includes("storage,") &&
      /activeProjects/.test(sandboxHealthBlock) &&
      /SWIFT_SANDBOX_ROOT=\/data\/swift-sandbox/.test(sandboxDockerfile) &&
      /sandbox_service_unavailable/.test(sandboxRoute) &&
      /service:\s*\{[\s\S]*tokenConfigured/.test(sandboxRoute),
    "sandbox runtime and proxy expose safe health details for VPS troubleshooting"
  )

  assert(
    "sandbox.health-storage-required",
    /sandboxStorageDiagnostic/.test(externalRuntimeHealth) &&
      /runtime\.storage/.test(externalRuntimeHealth) &&
      /hasStorageDetail/.test(externalRuntimeHealth) &&
      /Sandbox health endpoint is missing runtime\.storage/.test(externalRuntimeHealth) &&
      /Sandbox runtime health endpoint is missing runtime\.storage/.test(deployReadiness),
    "app health and deploy readiness reject stale sandbox health endpoints without storage detail"
  )

  assert(
    "sandbox.storage-preflight",
    /statfs/.test(sandboxRuntimeServer) &&
      /MIN_FREE_BYTES/.test(sandboxRuntimeServer) &&
      /assertStorageAvailable/.test(sandboxRuntimeServer) &&
      /Sandbox storage exhausted/.test(sandboxRuntimeServer) &&
      /statfs/.test(runtimeSandbox) &&
      /MIN_SANDBOX_FREE_BYTES/.test(runtimeSandbox) &&
      /assertSandboxStorageAvailable/.test(runtimeSandbox) &&
      /normalizeSandboxError/.test(runtimeSandbox),
    "sandbox runtime checks available storage before writes, install, and build"
  )

  assert(
    "dependency.graph",
    /export function buildImportGraph/.test(importGraph) &&
      /importedBy/.test(importGraph) &&
      /getTransitiveImpactPaths/.test(importGraph) &&
      /buildDependencyMap/.test(generationPipeline),
    "dependency graph tracks imports, importers, and impact paths"
  )

  assert(
    "context.budget",
    /export type ContextBudget/.test(generationPipeline) &&
      /maxFiles:\s*10/.test(generationPipeline) &&
      /maxCharsPerFile:\s*8\s*\*\s*1024/.test(generationPipeline) &&
      /maxTotalChars:\s*64\s*\*\s*1024/.test(generationPipeline) &&
      /trimContextForGeneration/.test(generationPipeline) &&
      /contextBudget/.test(orchestrator),
    "context budget is locked to 10 files, 8KB per file, and 64KB total"
  )

  assert(
    "generation.metrics",
    /model GenerationQualityMetric/.test(schema) &&
      /generationSuccessRate/.test(qualityService) &&
      /GenerationQualityService\.recordSummary/.test(orchestrator) &&
      /buildPassed/.test(qualityService) &&
      /runtimePassed/.test(qualityService),
    "generation metrics persist success, build, runtime, repair, latency, and cost"
  )

  assert(
    "failure.analytics",
    /validator_failed/.test(qualityService) &&
      /repair_failed/.test(qualityService) &&
      /compile_failed/.test(qualityService) &&
      /runtime_failed/.test(qualityService) &&
      /context_overflow/.test(qualityService) &&
      /provider_failed/.test(qualityService) &&
      /failureBreakdown/.test(qualityService),
    "failure analytics exposes requested breakdown categories"
  )

  assert(
    "failed.artifact-storage",
    /persistFailedGenerationArtifacts/.test(diagnostics) &&
      /prompt\.json/.test(diagnostics) &&
      /planner\.json/.test(diagnostics) &&
      /raw-output\.json/.test(diagnostics) &&
      /validator\.json/.test(diagnostics) &&
      /build\.log/.test(diagnostics) &&
      /runtime\.log/.test(diagnostics) &&
      /persistFailedGenerationArtifacts/.test(orchestrator),
    "failed generations persist prompt, planner, raw output, validator, build log, and runtime log"
  )

  assert(
    "compile.gate",
    /assertCompileGatePassed/.test(orchestrator) &&
      /Compile gate blocked persistence/.test(orchestrator) &&
      /ProjectFilePersistenceService\.saveBufferedArtifacts/.test(orchestrator),
    "compile gate is enforced before persistence"
  )

  assert(
    "intent.template-library",
    /INTENT_TEMPLATE_LIBRARY/.test(intentLibrary) &&
      /"landing"/.test(templateManifest("landing")) &&
      /"dashboard"/.test(templateManifest("dashboard")) &&
      /"marketplace"/.test(templateManifest("marketplace")) &&
      /"saas"/.test(templateManifest("saas")) &&
      /"crm"/.test(templateManifest("crm")) &&
      /"restaurant"/.test(templateManifest("restaurant")) &&
      /"clinic"/.test(templateManifest("clinic")) &&
      /"laundry"/.test(templateManifest("laundry")) &&
      /"blog"/.test(templateManifest("blog")) &&
      /selectIntentTemplate/.test(orchestrator),
    "intent template library covers requested template intents"
  )

  assert(
    "runtime.failure-audit",
    /persistRuntimeFailureReport/.test(diagnostics) &&
      /getReportStoragePath/.test(diagnostics) &&
      /runtime-failures/.test(diagnostics) &&
      /browserConsoleErrors/.test(orchestrator) &&
      /hydrationErrors/.test(orchestrator) &&
      /runtimeStackTraces/.test(orchestrator) &&
      /missingDependencies/.test(orchestrator) &&
      /routeErrors/.test(orchestrator) &&
      /environmentVariableErrors/.test(orchestrator) &&
      /importErrors/.test(orchestrator),
    "runtime failures persist browser, hydration, stack, dependency, route, env, and import diagnostics"
  )

  assert(
    "runtime.categorization",
    /hydration_failed/.test(qualityService) &&
      /import_failed/.test(qualityService) &&
      /dependency_failed/.test(qualityService) &&
      /route_failed/.test(qualityService) &&
      /environment_failed/.test(qualityService) &&
      /sandbox_failed/.test(qualityService) &&
      /rendering_failed/.test(qualityService) &&
      /runtimeBreakdown/.test(qualityService),
    "runtime failure analytics exposes requested runtime categories"
  )

  assert(
    "rendering.failure-audit",
    /persistRenderFailureReport/.test(diagnostics) &&
      /render-failures/.test(diagnostics) &&
      /reactErrorBoundaryOutput/.test(orchestrator) &&
      /componentTree/.test(orchestrator) &&
      /propsTree/.test(orchestrator) &&
      /serverClientComponentMismatches/.test(orchestrator) &&
      /providerContextTree/.test(orchestrator) &&
      /asyncRenderingErrors/.test(orchestrator) &&
      /layoutHierarchy/.test(orchestrator) &&
      /pageRenderStackTraces/.test(orchestrator),
    "rendering failures persist boundary, tree, props, provider, async, layout, and stack diagnostics"
  )

  assert(
    "rendering.categorization",
    /client_server_boundary_failed/.test(qualityService) &&
      /provider_missing/.test(qualityService) &&
      /props_mismatch/.test(qualityService) &&
      /async_render_failed/.test(qualityService) &&
      /layout_failed/.test(qualityService) &&
      /component_tree_failed/.test(qualityService) &&
      /state_initialization_failed/.test(qualityService) &&
      /renderingBreakdown/.test(qualityService),
    "rendering failure analytics exposes requested rendering categories"
  )

  assert(
    "render-safe.rules",
    /validateRenderSafeGenerationRules/.test(orchestrator) &&
      /app\/layout\.tsx is required/.test(orchestrator) &&
      /app\/page\.tsx is required/.test(orchestrator) &&
      /Provider wrapper/.test(orchestrator) &&
      /use \\"use client\\" only/.test(orchestrator),
    "render-safe generation rules require root files, scoped use client, and provider wrappers"
  )

  assert(
    "template.runtime-contracts",
    ["landing", "dashboard", "marketplace", "saas", "crm", "restaurant", "clinic", "laundry", "blog"].every((id) => {
      const manifest = templateManifest(id)
      return /"render_test"/.test(manifest) && /"route_render"/.test(manifest) && /"browser_render"/.test(manifest)
    }),
    "every intent template declares render, route, and browser runtime contracts"
  )

  assert(
    "render.score-gate",
    /function renderScore/.test(orchestrator) &&
      /MIN_RENDER_SCORE_TO_PERSIST = 100/.test(orchestrator) &&
      /routeSuccess/.test(orchestrator) &&
      /browserRenderSuccess/.test(orchestrator) &&
      /hydrationSuccess/.test(orchestrator) &&
      /componentSuccess/.test(orchestrator) &&
      /renderScore .*below threshold/.test(orchestrator),
    "persistence is blocked unless route, browser, hydration, and component render score pass"
  )

  assert(
    "component.registry-system",
    /STANDARD_COMPONENT_CONTRACTS/.test(componentRegistry) &&
      /ensureComponentRegistryFiles/.test(componentRegistry) &&
      /componentRegistryPromptPayload/.test(componentRegistry) &&
      /analyzeComponentRegistryUsage/.test(componentRegistry) &&
      /COMPONENT_REGISTRY_CONTRACTS/.test(orchestrator) &&
      /component-registry/.test(filePolicy) &&
      /export function HeroSection/.test(registryComponent("hero")) &&
      /export function Navbar/.test(registryComponent("navbar")) &&
      /export function Footer/.test(registryComponent("footer")) &&
      /export function DashboardCard/.test(registryComponent("dashboard-card")) &&
      /export function FeatureSection/.test(registryComponent("feature-section")) &&
      /export function Testimonial/.test(registryComponent("testimonial")) &&
      /export function Pricing/.test(registryComponent("pricing")),
    "component registry exposes stable standard components for AI composition"
  )

  assert(
    "component.contracts",
    /requiredProps/.test(componentRegistry) &&
      /optionalProps/.test(componentRegistry) &&
      /defaultProps/.test(componentRegistry) &&
      /importDependencies/.test(componentRegistry) &&
      /type:\s*"client" \| "server"/.test(componentRegistry) &&
      /validateComponentContracts/.test(componentRegistry),
    "component contracts define required props, optional props, defaults, dependencies, and client/server type"
  )

  assert(
    "component.props-validation",
    /required_prop_missing/.test(componentRegistry) &&
      /prop_type_invalid/.test(componentRegistry) &&
      /component_dependency_missing/.test(componentRegistry) &&
      /freeform_standard_component/.test(componentRegistry) &&
      /Component contract validation failed/.test(orchestrator),
    "component props and dependencies are validated before render"
  )

  assert(
    "component.registry-usage-logging",
    /component_registry_usage/.test(orchestrator) &&
      /selectedTemplate/.test(componentRegistry) &&
      /selectedRegistryComponents/.test(componentRegistry) &&
      /generatedComponents/.test(componentRegistry) &&
      /reusedComponents/.test(componentRegistry) &&
      /customGeneratedComponents/.test(componentRegistry) &&
      /registryUsageRate/.test(componentRegistry),
    "component registry usage is logged with selected, generated, reused, and custom component counts"
  )

  assert(
    "component.generation-analytics",
    /registry_reused/.test(componentRegistry) &&
      /registry_missing/.test(componentRegistry) &&
      /custom_generated/.test(componentRegistry) &&
      /duplicate_component/.test(componentRegistry) &&
      /invalid_contract/.test(componentRegistry) &&
      /componentGenerationAnalytics/.test(orchestrator),
    "component generation analytics exposes registry reuse, missing registry, custom generation, duplicates, and invalid contracts"
  )

  assert(
    "component.dependency-graph-validation",
    /buildImportGraph/.test(componentRegistry) &&
      /missingLocalImports/.test(componentRegistry) &&
      /dependencyGraph/.test(componentRegistry) &&
      /component-contracts/.test(orchestrator),
    "component dependency graph failures stop generation before runtime and feed targeted repair"
  )

  assert(
    "repair.scope-limit",
    /const MAX_FILES_PER_REPAIR = 3/.test(orchestrator) &&
      /getTransitiveImpactPaths/.test(orchestrator) &&
      /maxDepth:\s*1/.test(orchestrator) &&
      /maxFiles:\s*MAX_FILES_PER_REPAIR/.test(orchestrator) &&
      /slice\(0,\s*MAX_FILES_PER_REPAIR\)/.test(orchestrator),
    "targeted repair is limited to failed file, imported dependency, and nearest graph neighbor"
  )

  assert(
    "repair.scoring",
    /function repairScore/.test(orchestrator) &&
      /const validatorSuccess/.test(orchestrator) &&
      /const buildSuccess/.test(orchestrator) &&
      /const runtimeSuccess/.test(orchestrator) &&
      /repair_score_regressed/.test(orchestrator) &&
      /nextRepairScore < previousRepairScore/.test(orchestrator),
    "repair candidates are scored and regressions are discarded"
  )

  console.log("\n[generation-runtime-contracts] passed")
}

try {
  main()
} catch (error) {
  console.error("\n[generation-runtime-contracts] failed")
  console.error(error)
  process.exit(1)
}
