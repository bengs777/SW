const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const vm = require("node:vm")

const root = process.cwd()
const moduleCache = new Map()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[orchestration-scope] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[orchestration-scope] ${name} passed`)
}

function resolveAlias(id) {
  if (!id.startsWith("@/")) return null
  const relative = id.slice(2)
  for (const candidate of [`${relative}.ts`, `${relative}.tsx`, `${relative}.js`, relative]) {
    const absolute = path.join(root, candidate)
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return absolute
  }
  return null
}

function loadTsModule(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
  if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports

  const source = fs.readFileSync(absolute, "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const loadedModule = { exports: {} }
  moduleCache.set(absolute, loadedModule)

  const localRequire = (id) => {
    const alias = resolveAlias(id)
    if (alias) return loadTsModule(alias)
    return require(id)
  }

  vm.runInNewContext(compiled, {
    __dirname: path.dirname(absolute),
    __filename: absolute,
    console,
    exports: loadedModule.exports,
    module: loadedModule,
    process,
    require: localRequire,
  })

  return loadedModule.exports
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const architectureIntent = loadTsModule("lib/ai/architecture-intent.ts")
  const intentAnalyzer = loadTsModule("lib/ai/intent-analyzer.ts")
  const generationPipeline = loadTsModule("lib/ai/generation-pipeline.ts")
  const incrementalEdit = loadTsModule("lib/ai/incremental-edit.ts")
  const editPlanner = loadTsModule("lib/ai/edit-planner.ts")
  const architecturePlanner = loadTsModule("lib/ai/architecture-planner.ts")
  const softwareOrchestration = loadTsModule("lib/ai/software-orchestration.ts")
  const productUxPlanner = loadTsModule("lib/ai/product-ux-planner.ts")
  const filePolicy = loadTsModule("lib/ai/file-policy.ts")
  const collaborationMode = loadTsModule("lib/ai/collaboration-mode.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const generateJobsRoute = read("app/api/generate/jobs/route.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:orchestration-scope"] === "node scripts/orchestration-scope-regression.js",
    "package.json exposes npm run test:orchestration-scope"
  )

  const soto = architectureIntent.parseStructuredIntent({
    prompt: "soto restaurant homepage with hero, menu list, cart UI, checkout CTA, Tailwind, and mock data",
  })
  assert("soto.frontend-only", soto.type === "frontend_only", `expected frontend_only, got ${soto.type}`)
  assert("soto.no-backend", !soto.backend.api && !soto.database.provider && !soto.auth.provider, "soto UI prompt must not infer API/database/auth")
  assert("soto.no-business-backend", soto.businessRequirements.length === 0, "frontend-only prompt must not infer checkout/order business requirements")
  assert("soto.intent", intentAnalyzer.analyzePromptIntent("soto restaurant homepage").appType === "frontend_landing", "soto homepage maps to frontend_landing")
  assert("soto.pipeline", generationPipeline.classifyPrompt("soto restaurant homepage") === "simple_ui", "soto homepage maps to simple_ui")
  assert("checkout.pipeline", generationPipeline.classifyPrompt("food storefront with cart and checkout CTA") === "simple_ui", "checkout CTA must not promote storefront UI to fullstack")
  const sotoArchitecture = architecturePlanner.buildArchitecturePlan({ intent: soto })
  assert(
    "soto.architecture-frontend-only",
    sotoArchitecture.frontend.pages.length === 1 &&
      sotoArchitecture.frontend.pages[0] === "app/page.tsx" &&
      sotoArchitecture.backend.apiRoutes.length === 0 &&
      sotoArchitecture.backend.services.length === 0 &&
      sotoArchitecture.database.schema === "none" &&
      sotoArchitecture.auth.routes.length === 0,
    "frontend-only architecture must stay one page with no backend/auth/database routes"
  )

  const storefront = architectureIntent.parseStructuredIntent({
    prompt: "food storefront with cart, menu categories, product cards, and mobile responsive layout",
  })
  assert("storefront.frontend-only", storefront.type === "frontend_only", `expected frontend_only, got ${storefront.type}`)
  assert("storefront.no-models", storefront.database.models.length === 0 && storefront.backend.services.length === 0, "storefront UI prompt must not infer products/orders services")

  const warungDashboard = architectureIntent.parseStructuredIntent({
    prompt: "Buatkan web dashboard penjualan warung",
    appType: "simple_marketplace",
  })
  const warungArchitecture = architecturePlanner.buildArchitecturePlan({ intent: warungDashboard })
  const warungOrchestration = softwareOrchestration.createSoftwareOrchestration({
    prompt: "Buatkan web dashboard penjualan warung",
    appType: "simple_marketplace",
    structuredIntent: warungDashboard,
    architecture: warungArchitecture,
    projectMemory: { nodes: [], edges: [] },
    dependencyGraph: { nodes: [], edges: [], missingBusinessDependencies: [] },
    blueprintRequiredFiles: [],
  })
  assert(
    "warung-dashboard.not-storefront",
    warungOrchestration.plannerOutput.appType === "dashboard",
    `expected dashboard planner, got ${warungOrchestration.plannerOutput.appType}`
  )
  assert(
    "warung-dashboard.graph-valid",
    warungOrchestration.validation.ok,
    `dashboard commerce prompt should not fail storefront product/cart validation: ${warungOrchestration.validation.failures.join("; ")}`
  )
  const warungUxPlan = warungOrchestration.plannerOutput.uxProductPlan
  assert(
    "warung-dashboard.ux-plan",
    warungUxPlan &&
      warungUxPlan.appType === "dashboard" &&
      warungUxPlan.domain === "commerce_operations" &&
      warungUxPlan.screens.some((screen) => screen.sections.join(" ").toLowerCase().includes("kpi")) &&
      warungUxPlan.screens.some((screen) => screen.sections.join(" ").toLowerCase().includes("chart")) &&
      warungUxPlan.screens.some((screen) => screen.sections.join(" ").toLowerCase().includes("table")) &&
      warungUxPlan.screens.some((screen) => screen.sections.join(" ").toLowerCase().includes("filter")) &&
      warungUxPlan.screens.some((screen) => screen.states.includes("loading")) &&
      warungUxPlan.screens.some((screen) => screen.states.includes("empty")) &&
      warungUxPlan.screens.some((screen) => screen.states.includes("error")),
    `dashboard UX plan must define product-grade hierarchy and states: ${JSON.stringify(warungUxPlan)}`
  )
  assert(
    "warung-dashboard.no-generic-placeholders",
    warungUxPlan.dataSemantics.forbiddenPlaceholders.includes("Product 1") &&
      warungUxPlan.dataSemantics.forbiddenPlaceholders.includes("Project 1") &&
      warungUxPlan.dataSemantics.mockDataRules.some((rule) => /IDR|Indonesian|Penjualan|Stok/i.test(rule)),
    "dashboard UX plan must reject generic placeholders and require semantic commerce data"
  )
  const genericUxFailures = productUxPlanner.validateGeneratedUXQuality({
    plan: warungUxPlan,
    files: [
      {
        path: "app/page.tsx",
        content: "export default function Page(){ return <main><h1>Ecommerce Dashboard</h1><p>Product 1 $100</p></main> }",
      },
    ],
  })
  assert(
    "warung-dashboard.generic-output-rejected",
    genericUxFailures.some((failure) => /Product 1/.test(failure)),
    `generic dashboard output must be rejected: ${genericUxFailures.join("; ")}`
  )
  const semanticUxFailures = productUxPlanner.validateGeneratedUXQuality({
    plan: warungUxPlan,
    files: [
      {
        path: "app/page.tsx",
        content: [
          "export default function Page(){",
          "const rows = [{ nama: 'Beras Ramos', stok: 12, penjualan: 1850000 }]",
          "return <main>",
          "<section>KPI ringkasan penjualan dan stok</section>",
          "<section>Grafik chart tren penjualan</section>",
          "<input aria-label='Cari produk' placeholder='Cari produk atau filter periode tanggal' />",
          "<table><tbody>{rows.map((row)=><tr><td>{row.nama}</td></tr>)}</tbody></table>",
          "<p>Memuat data...</p><p>Belum ada data</p><p>Gagal memuat data, retry</p>",
          "</main>}",
        ].join(""),
      },
    ],
  })
  assert(
    "warung-dashboard.semantic-output-accepted",
    semanticUxFailures.length === 0,
    `semantic dashboard output should pass UX quality: ${semanticUxFailures.join("; ")}`
  )

  const commerceStorefront = architectureIntent.parseStructuredIntent({
    prompt: "Buat marketplace produk dengan cart checkout seller buyer dan admin",
    appType: "simple_marketplace",
  })
  const commerceArchitecture = architecturePlanner.buildArchitecturePlan({ intent: commerceStorefront })
  const commerceOrchestration = softwareOrchestration.createSoftwareOrchestration({
    prompt: "Buat marketplace produk dengan cart checkout seller buyer dan admin",
    appType: "simple_marketplace",
    structuredIntent: commerceStorefront,
    architecture: commerceArchitecture,
    projectMemory: { nodes: [], edges: [] },
    dependencyGraph: { nodes: [], edges: [], missingBusinessDependencies: [] },
    blueprintRequiredFiles: [],
  })
  assert(
    "storefront-commerce.stays-ecommerce",
    commerceOrchestration.plannerOutput.appType === "ecommerce",
    `expected ecommerce planner, got ${commerceOrchestration.plannerOutput.appType}`
  )
  assert(
    "storefront-commerce.ux-flow",
    commerceOrchestration.plannerOutput.uxProductPlan.flows.some((flow) => flow.steps.join(" ").toLowerCase().includes("checkout")) &&
      commerceOrchestration.plannerOutput.uxProductPlan.screens.some((screen) => screen.sections.join(" ").toLowerCase().includes("product grid")),
    "ecommerce UX plan must include product discovery and checkout flow"
  )

  const admin = architectureIntent.parseStructuredIntent({
    prompt: "build login admin dashboard with user roles and API routes",
  })
  assert("admin.fullstack", admin.type === "fullstack_app", `expected fullstack_app, got ${admin.type}`)
  assert("admin.auth", admin.auth.provider === "nextauth", "explicit login/admin prompt may request auth")

  const existingFiles = [
    { path: "app/page.tsx", content: "export default function Page(){return <main />}", language: "tsx" },
    { path: "components/ProductCard.tsx", content: "export function ProductCard(){return <article />}", language: "tsx" },
  ]
  assert(
    "existing-project-build-can-stay-full-frontend",
    incrementalEdit.detectGenerationMode({
      prompt: "build a modern full website",
      existingFiles,
    }) === "FULL_FRONTEND",
    "existing project prompts must allow broad frontend generation when the user asks for a full website"
  )
  const singleFileEditPlan = editPlanner.buildPartialEditPlan({
    prompt: "MODE: Edit\nTARGET FILE: app/page.tsx\nedit only one file",
    existingFiles,
    collaborationMode: "edit",
  })
  assert(
    "edit-only-one-file",
    singleFileEditPlan.mode === "partial" &&
      singleFileEditPlan.targetPaths.length === 1 &&
      singleFileEditPlan.targetPaths[0] === "app/page.tsx" &&
      singleFileEditPlan.allowedNewPaths.length === 0,
    `expected one-file partial edit, got ${JSON.stringify(singleFileEditPlan)}`
  )
  const replacementPlan = editPlanner.buildPartialEditPlan({
    prompt: "rebuild full website with modern UI",
    existingFiles,
  })
  assert(
    "full-replacement-existing-is-broad",
    replacementPlan.mode === "full",
    "existing project rebuild language must allow broad full frontend scope"
  )
  const checkoutUiEditPlan = editPlanner.buildPartialEditPlan({
    prompt: "Tambahkan checkout CTA di app/page.tsx only",
    existingFiles,
    collaborationMode: "edit",
  })
  assert(
    "checkout-ui-not-payment-integration",
    checkoutUiEditPlan.intent !== "payment_integration" &&
      checkoutUiEditPlan.allowedNewPaths.length === 0,
    `checkout UI copy must not add payment backend paths, got ${JSON.stringify(checkoutUiEditPlan)}`
  )
  assert(
    "fix-mode",
    incrementalEdit.detectGenerationMode({
      prompt: "fix runtime error in app/page.tsx",
      existingFiles,
    }) === "PATCH",
    "fix prompts must become PATCH"
  )

  assert(
    "valid-target-path",
    filePolicy.validateGeneratedPath("./app/page.tsx").path === "app/page.tsx",
    "valid target file normalizes to canonical POSIX path"
  )
  for (const invalidPath of ["C:\\tmp\\app\\page.tsx", "../app/page.tsx", ".env", "node_modules/x.ts"]) {
    let rejected = false
    try {
      filePolicy.validateGeneratedPath(invalidPath)
    } catch {
      rejected = true
    }
    assert(`invalid-path.${invalidPath}`, rejected, "unsupported path must be rejected")
  }

  assert(
    "orchestrator.single-file-guard",
    /const singleFileOnly = explicitlyRequestedPaths\.length === 1/.test(orchestrator) &&
      /singleFileOnly \? \[\] : requiredFilesForIntent/.test(orchestrator) &&
      /singleFileOnly \? \[\] : orchestration\.plannerOutput\.requiredComponents/.test(orchestrator),
    "single-file prompts suppress required files and component expansion"
  )
  assert(
    "orchestrator.frontend-blueprint",
    /structuredIntent\.type === "frontend_only"[\s\S]*\? "frontend_landing"/.test(orchestrator),
    "frontend-only prompts select frontend_landing blueprint"
  )
  assert(
    "orchestrator.checkout-not-fullstack",
    !/payment\|checkout\|webhook/.test(orchestrator) && /payment\|payments\|bayar/.test(orchestrator),
    "checkout alone must not be treated as explicit fullstack intent"
  )
  assert(
    "repair.minimal-fix",
    /const minimalRepairOnly = syntaxRepairOnly/.test(orchestrator) &&
      /MINIMAL_FIX_MODE/.test(orchestrator) &&
      /minimalRepairOnly[\s\S]*acceptedFiles: parsed\.files\.filter/.test(orchestrator),
    "FIX repair is constrained to failing files"
  )
  assert(
    "scoped-edit-provider-fallback",
    /type: "scoped_edit_provider_fallback"/.test(orchestrator) &&
      /providerScopedEditAllowed: true/.test(orchestrator) &&
      !/throw new Error\(`Scoped edit was not applied:/.test(orchestrator),
    "unmatched deterministic scoped edits must continue to provider scoped edit instead of failing the job"
  )
  assert(
    "production-browser-preview-post-audit",
    /acceptsBrowserPreviewOnly[\s\S]*isProductionVercel\(\)[\s\S]*input\.persistedFiles\.length > 0[\s\S]*SWIFT_REQUIRE_SANDBOX_FOR_PRODUCTION_FULLSTACK/.test(orchestrator) &&
      /previewMode:[\s\S]*browser-preview-only/.test(orchestrator),
    "Vercel production post-generation audit must not fail persisted files only because no local preview URL exists"
  )
  assert(
    "post-generation-ux-quality-gate",
    /validateGeneratedUXQuality/.test(orchestrator) &&
      /plannerOutput\.uxProductPlan/.test(orchestrator),
    "post-generation audit must enforce UX quality against the planner contract"
  )
  assert(
    "orchestration.ux-contract-instructions",
    /UX_PRODUCT_PLAN/.test(softwareOrchestration.buildRoleInstructionBlock({ diagnostics: warungOrchestration, role: "builder" })) &&
      /Do not generate UI from the raw prompt alone/.test(softwareOrchestration.buildRoleInstructionBlock({ diagnostics: warungOrchestration, role: "builder" })) &&
      /Product UX Planning/.test(read("lib/ai/software-orchestration.ts")),
    "builder instructions must include the UX product plan contract"
  )
  assert(
    "collaboration-mode.enum",
    collaborationMode.isCollaborationMode("build") &&
      collaborationMode.isCollaborationMode("review") &&
      !collaborationMode.isCollaborationMode("dashboard") &&
      collaborationMode.normalizeCollaborationMode("FIX") === "fix" &&
      collaborationMode.normalizeCollaborationMode("dashboard") === "build",
    "collaboration mode must be a closed enum with deterministic normalization"
  )
  assert(
    "generate-job-mode-schema",
    /COLLABORATION_MODES/.test(generateJobsRoute) &&
      /z\.enum\(COLLABORATION_MODES\)\.optional\(\)\.default\("build"\)/.test(generateJobsRoute),
    "generate job API must validate collaborationMode against the shared enum"
  )

  console.log("[orchestration-scope] orchestration scope regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[orchestration-scope] orchestration scope regression checks failed")
  console.error(error)
  process.exit(1)
}
