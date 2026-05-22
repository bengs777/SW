const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const root = process.cwd()
const requiredCommands = [
  ["npm", ["run", "lint"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
]

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function exists(file) {
  return fs.existsSync(path.join(root, file))
}

function check(name, pass, detail, severity = "error") {
  return { name, pass: Boolean(pass), detail, severity }
}

function run(command, args) {
  const executable = process.platform === "win32" ? "cmd.exe" : command
  const executableArgs = process.platform === "win32" ? ["/d", "/s", "/c", `${command} ${args.join(" ")}`] : args
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
  })

  return {
    command: `${command} ${args.join(" ")}`,
    pass: result.status === 0,
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`.trim(),
  }
}

function staticChecks() {
  const packageJson = JSON.parse(read("package.json"))
  const gitignore = exists(".gitignore") ? read(".gitignore") : ""
  const generateJobsRoute = exists("app/api/generate/jobs/route.ts") ? read("app/api/generate/jobs/route.ts") : ""
  const providerRouter = exists("lib/ai/provider-router.ts") ? read("lib/ai/provider-router.ts") : ""
  const swiftTiers = exists("lib/ai/swift-tiers.ts") ? read("lib/ai/swift-tiers.ts") : ""
  const generationPipeline = exists("lib/ai/generation-pipeline.ts") ? read("lib/ai/generation-pipeline.ts") : ""
  const softwareOrchestration = exists("lib/ai/software-orchestration.ts") ? read("lib/ai/software-orchestration.ts") : ""
  const productUxPlanner = exists("lib/ai/product-ux-planner.ts") ? read("lib/ai/product-ux-planner.ts") : ""
  const generationOrchestrator = exists("lib/services/generation-orchestrator.service.ts")
    ? read("lib/services/generation-orchestrator.service.ts")
    : ""
  const appBlueprints = exists("lib/ai/app-blueprints.ts") ? read("lib/ai/app-blueprints.ts") : ""
  const generationQualityService = exists("lib/services/generation-quality.service.ts")
    ? read("lib/services/generation-quality.service.ts")
    : ""
  const editPlanner = exists("lib/ai/edit-planner.ts") ? read("lib/ai/edit-planner.ts") : ""
  const importGraph = exists("lib/ai/import-graph.ts") ? read("lib/ai/import-graph.ts") : ""
  const healthRoute = exists("app/api/health/route.ts") ? read("app/api/health/route.ts") : ""
  const generationQueue = exists("lib/queue/generation-queue.ts") ? read("lib/queue/generation-queue.ts") : ""
  const generationWorker = exists("lib/workers/generation-worker.ts") ? read("lib/workers/generation-worker.ts") : ""
  const billingService = exists("lib/services/billing.service.ts") ? read("lib/services/billing.service.ts") : ""
  const persistenceService = exists("lib/services/project-file-persistence.service.ts")
    ? read("lib/services/project-file-persistence.service.ts")
    : ""
  const filesystemService = exists("lib/services/project-filesystem.service.ts")
    ? read("lib/services/project-filesystem.service.ts")
    : ""
  const taskGraphExecutor = exists("lib/ai/task-graph-executor.ts") ? read("lib/ai/task-graph-executor.ts") : ""
  const generatedArtifact = exists("lib/ai/generated-artifact.ts") ? read("lib/ai/generated-artifact.ts") : ""
  const sandboxRuntime = exists("lib/sandbox/runtime.ts") ? read("lib/sandbox/runtime.ts") : ""
  const preview = exists("components/editor/sandbox-preview.tsx") ? read("components/editor/sandbox-preview.tsx") : ""
  const prisma = exists("prisma/schema.prisma") ? read("prisma/schema.prisma") : ""
  const deployRoute = exists("app/api/projects/[id]/deploy/route.ts")
    ? read("app/api/projects/[id]/deploy/route.ts")
    : ""

  return [
    check("predeploy.lint-script", packageJson.scripts && packageJson.scripts.lint, "package.json exposes npm run lint"),
    check("predeploy.typecheck-script", packageJson.scripts && packageJson.scripts.typecheck, "package.json exposes npm run typecheck"),
    check("predeploy.build-script", packageJson.scripts && packageJson.scripts.build, "package.json exposes npm run build"),
    check("ai.zod-input-validation", /z\.object\(/.test(generateJobsRoute), "Canonical queued AI endpoint validates request input with Zod"),
    check(
      "ai.single-orchestrator-model",
      /SWIFT_BUILDER_MODEL_KEY\s*=\s*"swift-builder"/.test(swiftTiers) &&
        /configuredPrimaryModel/.test(swiftTiers) &&
        /configuredFallbackModels/.test(swiftTiers) &&
        /SWIFT_AI_FREE_MODE/.test(swiftTiers) &&
        !/deepseek-v4-flash|deepseek-v3\.2|OPENROUTER_DEEPSEEK_FLASH|OPENROUTER_DEEPSEEK_V32/.test(
          [swiftTiers, providerRouter, generationPipeline].join("\n")
        ),
      "Swift AI runtime uses one public builder orchestrator backed by environment-configured model routing"
    ),
    check(
      "ai.single-public-model-option",
      (swiftTiers.match(/public:\s*true/g) || []).length === 1 &&
        !/SWIFT_FAST_MODEL_KEY/.test(generationPipeline),
      "Public model selection exposes one Swift AI orchestrator and routing never selects a fast lane"
    ),
    check(
      "ai.production-fullstack-mode",
      /shouldUseProductionFullStackMode/.test(generationOrchestrator) &&
        /PRODUCTION_FULLSTACK_FILE_LIMIT\s*=\s*16/.test(generationOrchestrator) &&
        /PRODUCTION_FULLSTACK_BATCH_SIZE\s*=\s*8/.test(generationOrchestrator) &&
        /buildFastClinicFullStackScaffold/.test(generationOrchestrator) &&
        /productionMode:\s*"preview"\s*\|\s*"production_fullstack"/.test(generationOrchestrator),
      "Explicit full-stack/admin/API/payment prompts use a production full-stack orchestration mode"
    ),
    check(
      "ai.server-prisma-boundary",
      /function isBrowserPreviewFile/.test(generationPipeline) &&
        /normalized\.startsWith\("app\/api\/"\)\)\s*return false/.test(generationPipeline) &&
        /normalized\.startsWith\("lib\/services\/"\)\)\s*return false/.test(generationPipeline),
      "Prisma and server-only imports are allowed in API routes and service files, but still blocked from preview UI"
    ),
    check("ai.output-file-extraction", /parseGeneratedArtifact/.test(generationOrchestrator) && /generatedArtifactSchema/.test(generatedArtifact), "AI provider output is parsed into a strict GeneratedArtifact schema"),
    check("ai.controlled-app-blueprints", /ControlledAppType/.test(appBlueprints) && /saas_dashboard/.test(appBlueprints) && /simple_marketplace/.test(appBlueprints), "Generation is constrained to controlled app categories"),
    check("ai.intent-taskgraph-generation", /analyzePromptIntent/.test(generationOrchestrator) && /executeGeneratedTaskGraph/.test(generationOrchestrator), "Generation uses intent analysis and TaskGraph execution instead of starter-only output"),
    check(
      "ai.product-ux-planner-contract",
      /UXProductPlan/.test(productUxPlanner) &&
        /buildUXProductPlan/.test(productUxPlanner) &&
        /validateGeneratedUXQuality/.test(productUxPlanner) &&
        /uxProductPlan/.test(softwareOrchestration) &&
        /UX_PRODUCT_PLAN/.test(softwareOrchestration),
      "Planner produces a product UX contract that is passed to builders"
    ),
    check(
      "ai.post-generation-ux-gate",
      /validateGeneratedUXQuality/.test(generationOrchestrator) &&
        /plannerOutput\.uxProductPlan/.test(generationOrchestrator) &&
        /Product 1/.test(productUxPlanner) &&
        /Project 1/.test(productUxPlanner),
      "Post-generation audit rejects generic placeholders and enforces UX quality"
    ),
    check("ai.partial-regeneration-contract", /buildPartialEditPlan/.test(editPlanner) && /filterFilesForPartialEdit/.test(generationOrchestrator), "Conversational edits are scoped to target files and allowed new files"),
    check("ai.edit-intent-classifier", /pricing_page/.test(editPlanner) && /schema_change/.test(editPlanner) && /upload_integration/.test(editPlanner), "Edit planner classifies common retention-driving edit intents"),
    check("ai.import-graph", /buildImportGraph/.test(importGraph) && /importedBy/.test(importGraph) && /getTransitiveImpactPaths/.test(editPlanner), "Import graph powers reverse dependency lookup and transitive edit impact analysis"),
    check("ai.generation-quality-metrics", /model GenerationQualityMetric/.test(prisma) && /GenerationQualityService/.test(generationQualityService), "Generation success, build, runtime, repair, latency, and cost metrics are persisted"),
    check("ai.fullstack-validation", /validateFullStackFiles|attemptTargetedRepair/.test(generationOrchestrator), "Generated files pass full-stack coverage validation"),
    check("ai.syntax-validation", /compileProject|validateFullStackFiles/.test(generationOrchestrator), "Generated executable files have TypeScript syntax validation signals"),
    check("ai.runtime-smoke-required", /runtime-smoke/.test(generationOrchestrator) && /verifyRuntimeSmoke/.test(sandboxRuntime), "Generation success requires runtime smoke validation"),
    check("ai.atomic-generation-billing", /reserveGenerationJob/.test(generateJobsRoute) && /reserveGenerationJob/.test(billingService), "Generation job creation and billing reservation are atomic"),
    check("ai.request-hash-dedupe", /requestHash/.test(prisma) && /@@unique\(\[userId,\s*projectId,\s*requestHash\]\)/.test(prisma), "Request hash dedupe is enforced at the database level"),
    check("ai.persistence-idempotency", /@@unique\(\[projectId,\s*idempotencyKey\]\)/.test(prisma) && /upsert/.test(persistenceService), "Generation persistence is replay-safe"),
    check("ai.canonical-filesystem", /class ProjectFilesystemService/.test(filesystemService) && /replaceFiles/.test(persistenceService) && /ProjectFilesystemService\.readFiles/.test(generationWorker), "Project files flow through the canonical filesystem service"),
    check("ai.manifest-verification", /fileHashes/.test(filesystemService) && /PersistenceIntegrityError/.test(filesystemService) && /verify\(input\.projectId/.test(filesystemService), "Persisted project files are verified with content-hash manifests"),
    check("ai.taskgraph-hardening", /collapseOperations/.test(taskGraphExecutor) && /Dependency is not allowed by Swift policy/.test(taskGraphExecutor) && /MAX_OPERATIONS\s*=\s*100/.test(taskGraphExecutor), "TaskGraph execution has merge semantics, dependency policy, and resource limits"),
    check("ai.stale-generation-guard", /pg_advisory_xact_lock/.test(persistenceService) && /StaleGenerationRejected/.test(persistenceService), "Older project generations are rejected during persistence"),
    check("sandbox.path-guard", /assertSafeFilePath/.test(sandboxRuntime) && /startsWith\(`\$\{root\}\$\{path\.sep\}`\)/.test(sandboxRuntime), "Sandbox rejects path traversal writes"),
    check(
      "sandbox.command-timeout",
      /setTimeout\([\s\S]*(child\.kill\(\)|killProcessTree\(child\))/.test(sandboxRuntime),
      "Sandbox commands have timeout cleanup"
    ),
    check("sandbox.process-restart", /stopProcess/.test(sandboxRuntime) && /resetRuntimeSandbox/.test(sandboxRuntime), "Sandbox supports process stop and reset"),
    check("sandbox.npm-install-ignore-scripts", /npm["'], \["install", "--ignore-scripts"/.test(sandboxRuntime) && /SWIFT_SANDBOX_COPY_ROOT_LOCK/.test(sandboxRuntime), "Runtime sandbox installs generated apps without lifecycle scripts or root lockfile drift"),
    check("sandbox.build-before-preview", /npm["'], \["run", "db:generate"/.test(sandboxRuntime) && /npm["'], \["run", "build"/.test(sandboxRuntime), "Runtime sandbox runs Prisma generate and build before preview"),
    check("ops.health-route", /getGenerationQueueHealth/.test(healthRoute) && /ProviderRouter/.test(healthRoute), "Health endpoint reports database, queue, env, and provider status"),
    check("ops.worker-heartbeat", /recordGenerationWorkerHeartbeat/.test(generationQueue) && /recordGenerationWorkerHeartbeat/.test(generationWorker), "Queue health includes worker heartbeat reporting"),
    check("ops.sentry-config", exists("instrumentation.ts") && exists("instrumentation-client.ts") && exists("sentry.server.config.ts"), "Sentry instrumentation exists for client and server runtimes"),
    check("ops.chaos-script", packageJson.scripts && packageJson.scripts["test:chaos"] && exists("scripts/chaos-concurrency.js"), "Concurrency chaos test script is available"),
    check("ops.resilience-script", packageJson.scripts && packageJson.scripts["test:resilience"] && exists("scripts/pipeline-resilience-smoke.js"), "Pipeline resilience smoke test script is available"),
    check("ops.hardening-regression-script", packageJson.scripts && packageJson.scripts["test:hardening"] && exists("scripts/pipeline-hardening-regression.js"), "Pipeline hardening regression gate is available"),
    check("ops.prompt-corpus-script", packageJson.scripts && packageJson.scripts["test:corpus"] && exists("scripts/prompt-corpus-regression.js") && exists("fixtures/prompts/malicious.txt"), "Prompt corpus regression gate is available"),
    check("preview.iframe-sandbox", /sandbox="[^"]*allow-scripts/.test(preview), "Preview iframe uses sandbox attribute"),
    check("preview.iframe-no-same-origin", !/sandbox="[^"]*allow-same-origin/.test(preview), "Preview iframe does not combine allow-scripts with allow-same-origin", "warn"),
    check("preview.error-boundary", /ErrorBoundary/.test(preview), "Preview contains an error boundary"),
    check("preview.compile-timeout", /timed out/.test(preview) && /15000/.test(preview), "Preview compilation has timeout protection"),
    check("security.env-gitignore", /^\.env$/m.test(gitignore) && /^\.env\*\.local$/m.test(gitignore), ".env and local env files are ignored"),
    check("db.project-file-unique", /@@unique\(\[projectId,\s*path\]\)/.test(prisma), "Project files are unique per project path"),
    check("db.history-index", /model GenerationHistory[\s\S]*@@index\(\[projectId/.test(prisma), "Generation history is indexed by project"),
    check("cost.request-logs", /model RequestLog/.test(prisma) && /tokens\s+Int/.test(prisma), "Request logs capture token usage signals"),
    check("cost.usage-logs", /model UsageLog/.test(prisma) && /cost\s+Int/.test(prisma), "Usage logs capture cost signals"),
    check("deploy.route-present", Boolean(deployRoute), "Project deployment route exists"),
    check("deploy.vercel-build-script", exists("scripts/vercel-build.js"), "Vercel build wrapper exists"),
  ]
}

function printSection(title) {
  console.log(`\n${title}`)
  console.log("-".repeat(title.length))
}

function main() {
  const commandResults = requiredCommands.map(([command, args]) => run(command, args))
  const checks = staticChecks()

  printSection("Command Gates")
  for (const result of commandResults) {
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.command}`)
    if (!result.pass) {
      console.log(result.output.slice(-4000))
    }
  }

  printSection("Static Audit")
  for (const item of checks) {
    const label = item.pass ? "PASS" : item.severity === "warn" ? "WARN" : "FAIL"
    console.log(`${label} ${item.name} - ${item.detail}`)
  }

  const failedCommands = commandResults.filter((item) => !item.pass)
  const failedChecks = checks.filter((item) => !item.pass && item.severity !== "warn")
  const warnings = checks.filter((item) => !item.pass && item.severity === "warn")

  printSection("Summary")
  console.log(`Commands: ${commandResults.length - failedCommands.length}/${commandResults.length} passed`)
  console.log(`Static checks: ${checks.length - failedChecks.length - warnings.length}/${checks.length} passed, ${warnings.length} warning(s)`)

  if (failedCommands.length > 0 || failedChecks.length > 0) {
    process.exitCode = 1
  }
}

main()
