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
  const workerHealthRoute = read("app/api/worker/health/route.ts")
  const generationQueue = read("lib/queue/generation-queue.ts")
  const generationWorker = read("lib/workers/generation-worker.ts")
  const generationPipeline = read("lib/ai/generation-pipeline.ts")
  const importGraph = read("lib/ai/import-graph.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
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
      /SWIFT_GENERATION_EXECUTION_MODE=queue/.test(workerDockerfile),
    "worker image runs queue mode standalone"
  )

  assert(
    "worker.health-server",
    /http\.createServer/.test(workerEntry) &&
      /\/api\/worker\/health/.test(workerEntry) &&
      /mode:\s*"queue"/.test(workerEntry),
    "standalone worker exposes process health"
  )

  assert(
    "worker.health-route",
    /getGenerationQueueHealth/.test(workerHealthRoute) &&
      /deadLetter/.test(workerHealthRoute) &&
      /heartbeat/.test(workerHealthRoute) &&
      /mode:\s*"queue"/.test(workerHealthRoute),
    "app health endpoint reports queue, heartbeat, and DLQ status"
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
