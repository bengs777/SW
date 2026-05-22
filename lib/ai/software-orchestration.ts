import type { SwiftArchitecturePlan } from "@/lib/ai/architecture-planner"
import type { SwiftStructuredIntent } from "@/lib/ai/architecture-intent"
import type { SwiftDependencyGraph, SwiftProjectMemoryGraph } from "@/lib/ai/project-memory-graph"

export type SoftwareOrchestrationRole =
  | "planner"
  | "architecture"
  | "builder"
  | "validator"
  | "repair"
  | "ui_enhancement"

export type PlannerComplexity = "low" | "medium" | "high"

export type PlannerOutput = {
  appType: "ecommerce" | "dashboard" | "landing" | "blog" | "portfolio" | "saas" | "other"
  confidence: number
  features: string[]
  complexity: PlannerComplexity
  requiredRoutes: string[]
  requiredComponents: string[]
  requiredFiles: string[]
}

export type RouteGraph = {
  routes: Array<{ path: string; kind: "page" | "api"; reason: string }>
}

export type ComponentGraph = {
  components: Array<{ path: string; ownerRoute?: string | null; reason: string }>
}

export type DependencyGraphSummary = {
  dependencies: SwiftDependencyGraph["nodes"]
  edges: SwiftDependencyGraph["edges"]
  missingBusinessDependencies: string[]
}

export type IntentGraph = {
  appType: string
  archetype: string
  domain: string
  features: string[]
  requiredRoutes: string[]
  requiredComponents: string[]
  requiredFiles: string[]
}

export type ArchitectureOutput = {
  archetype: string
  requiredRoutes: string[]
  requiredComponents: string[]
  routes: string[]
  components: string[]
  dependencies: string[]
  requiredFiles: string[]
  allowedFiles: string[]
  forbiddenPatterns: string[]
  validationRules: string[]
}

export type ScaffoldValidationResult = {
  ok: boolean
  missingFiles: string[]
  checkedFiles: string[]
}

export type SoftwareOrchestrationGraphs = {
  intentGraph: IntentGraph
  routeGraph: RouteGraph
  componentGraph: ComponentGraph
  dependencyGraph: DependencyGraphSummary
}

export type SoftwareOrchestrationDiagnostics = {
  plannerModel: string
  architectureModel: string
  builderModel: string
  validatorModel: string
  repairModel: string
  uiEnhancementModel: string
  plannerConfidence: number
  selectedArchetype: string
  pipeline: string[]
  roleBoundaries: Record<SoftwareOrchestrationRole, string[]>
  repairPath: Array<{
    attempt: number
    model: string
    failedScope: string
    issueType: string
    fixPlan: string
    filesToEdit: string[]
    targetFiles: string[]
    reason: string
  }>
  plannerOutput: PlannerOutput
  architectureOutput: ArchitectureOutput
  graphs: SoftwareOrchestrationGraphs
  validationStatus: "pending" | "passed" | "failed" | "blocked"
  failedScope: string
  repairCount: number
  allowedScope: string[]
  rejectedFiles: string[]
  previewStatus: string
  commitStatus: "pending" | "persisted" | "failed"
  validation: {
    ok: boolean
    failures: string[]
  }
}

export const SOFTWARE_ORCHESTRATION_PIPELINE = [
  "Intent Planning",
  "Architecture Planning",
  "Graph Construction",
  "Allowed Scope Definition",
  "Scaffold Validation",
  "Scoped File Generation",
  "Scope Validation",
  "Runtime Validation",
  "Targeted Repair",
  "Preview Boot",
  "Final Commit",
]

const DEFAULT_ROLE_MODELS: Record<SoftwareOrchestrationRole, string> = {
  planner: "gpt-4o-mini",
  architecture: "claude-sonnet",
  builder: "deepseek",
  validator: "gpt-4o-mini",
  repair: "deepseek",
  ui_enhancement: "gemini",
}

export function modelForSoftwareRole(role: SoftwareOrchestrationRole) {
  const envKey = `SWIFT_${role.toUpperCase()}_MODEL`
  return process.env[envKey]?.trim() || DEFAULT_ROLE_MODELS[role]
}

export function createSoftwareOrchestration(input: {
  prompt: string
  appType: string
  structuredIntent: SwiftStructuredIntent
  architecture: SwiftArchitecturePlan
  projectMemory: SwiftProjectMemoryGraph
  dependencyGraph: SwiftDependencyGraph
  blueprintRequiredFiles: string[]
}): SoftwareOrchestrationDiagnostics {
  const plannerOutput = buildPlannerOutput(input)
  const graphs = buildGraphs({
    structuredIntent: input.structuredIntent,
    architecture: input.architecture,
    dependencyGraph: input.dependencyGraph,
    plannerOutput,
  })
  const architectureOutput = buildArchitectureOutput({
    architecture: input.architecture,
    dependencyGraph: input.dependencyGraph,
    plannerOutput,
    componentGraph: graphs.componentGraph,
  })
  const validationFailures = validateGraphsAgainstPlanner(plannerOutput, graphs)

  return {
    plannerModel: modelForSoftwareRole("planner"),
    architectureModel: modelForSoftwareRole("architecture"),
    builderModel: modelForSoftwareRole("builder"),
    validatorModel: modelForSoftwareRole("validator"),
    repairModel: modelForSoftwareRole("repair"),
    uiEnhancementModel: modelForSoftwareRole("ui_enhancement"),
    plannerConfidence: plannerOutput.confidence,
    selectedArchetype: plannerOutput.appType,
    pipeline: SOFTWARE_ORCHESTRATION_PIPELINE,
    roleBoundaries: {
      planner: ["detect intent", "classify app archetype", "extract features", "estimate complexity"],
      architecture: ["generate route graph", "generate component graph", "generate dependency graph", "define scaffold"],
      builder: ["generate scoped files", "generate isolated React modules", "follow explicit props and targets"],
      validator: ["compare user intent against architecture", "validate routes, imports, schema, and runtime gates"],
      repair: ["fix isolated syntax, import, runtime, hydration, and build failures"],
      ui_enhancement: ["improve spacing", "improve responsive layout", "improve hierarchy", "improve visual consistency"],
    },
    repairPath: [],
    plannerOutput,
    architectureOutput,
    graphs,
    validationStatus: validationFailures.length === 0 ? "pending" : "failed",
    failedScope: validationFailures.length === 0 ? "" : "architecture",
    repairCount: 0,
    allowedScope: architectureOutput.allowedFiles,
    rejectedFiles: [],
    previewStatus: "pending",
    commitStatus: "pending",
    validation: {
      ok: validationFailures.length === 0,
      failures: validationFailures,
    },
  }
}

export function buildRoleInstructionBlock(input: {
  diagnostics: SoftwareOrchestrationDiagnostics
  role: SoftwareOrchestrationRole
}) {
  const role = input.role
  const boundaries = input.diagnostics.roleBoundaries[role]
  return [
    "SOFTWARE_ORCHESTRATION_CONTRACT:",
    JSON.stringify(
      {
        pipeline: input.diagnostics.pipeline,
        activeRole: role,
        model: modelForSoftwareRole(role),
        boundaries,
        plannerOutput: input.diagnostics.plannerOutput,
        architectureOutput: input.diagnostics.architectureOutput,
        allowedFileScope: input.diagnostics.allowedScope,
        rejectedFiles: input.diagnostics.rejectedFiles,
        graphs: input.diagnostics.graphs,
        validation: input.diagnostics.validation,
      },
      null,
      2
    ),
    "Role isolation rules:",
    "- Planner output, route graph, component graph, and dependency graph are already validated before code generation.",
    "- Builder must only generate the requested scoped file/module and direct imports required by that scope.",
    "- Builder must never redesign architecture, reinterpret user intent, or modify route graph.",
    "- UI Enhancement may refine layout polish only inside the scoped target and must not alter business logic.",
    "- Repair must be targeted to failing files only and must not regenerate the full app.",
  ].join("\n")
}

export function assertSoftwareOrchestrationReady(diagnostics: SoftwareOrchestrationDiagnostics) {
  if (diagnostics.plannerConfidence < 0.75) {
    throw new Error(
      `Planner confidence ${diagnostics.plannerConfidence} is below 0.75; Architecture AI escalation is required before generation.`
    )
  }

  if (!diagnostics.validation.ok) {
    throw new Error(`Orchestration graph validation failed: ${diagnostics.validation.failures.join("; ")}`)
  }
}

export function appendRepairPath(
  diagnostics: SoftwareOrchestrationDiagnostics | undefined,
  input: {
    attempt: number
    targetFiles: string[]
    reason: string
    failedScope?: string
    issueType?: string
    fixPlan?: string
  }
) {
  if (!diagnostics) return
  const issueType = input.issueType || classifyIssueType(input.reason)
  const model = modelForRepairIssue(issueType)
  diagnostics.repairPath.push({
    attempt: input.attempt,
    model,
    failedScope: input.failedScope || inferFailedScope(input.targetFiles, input.reason),
    issueType,
    fixPlan: input.fixPlan || fixPlanForIssue(issueType),
    filesToEdit: input.targetFiles,
    targetFiles: input.targetFiles,
    reason: input.reason,
  })
  diagnostics.repairCount = diagnostics.repairPath.length
}

export function validateProjectScaffold(input: {
  paths: string[]
}): ScaffoldValidationResult {
  const normalized = new Set(input.paths.map(normalizePath).filter(Boolean))
  const missingFiles: string[] = []
  const requireAny = (label: string, candidates: string[]) => {
    if (!candidates.some((candidate) => normalized.has(candidate))) missingFiles.push(label)
  }

  requireAny("app/layout.tsx", ["app/layout.tsx", "src/app/layout.tsx"])
  requireAny("app/page.tsx", ["app/page.tsx", "src/app/page.tsx"])
  requireAny("app/globals.css", ["app/globals.css", "src/app/globals.css"])
  requireAny("package.json", ["package.json"])
  requireAny("tsconfig.json", ["tsconfig.json"])
  requireAny("tailwind.config.ts", ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs"])

  return {
    ok: missingFiles.length === 0,
    missingFiles,
    checkedFiles: Array.from(normalized).sort(),
  }
}

export function markOrchestrationValidation(
  diagnostics: SoftwareOrchestrationDiagnostics | undefined,
  input: {
    status: SoftwareOrchestrationDiagnostics["validationStatus"]
    failedScope?: string
    failures?: string[]
  }
) {
  if (!diagnostics) return
  diagnostics.validationStatus = input.status
  diagnostics.failedScope = input.failedScope || ""
  if (input.failures) {
    diagnostics.validation = {
      ok: input.status === "passed",
      failures: input.failures,
    }
  }
}

export function markScopeRejections(
  diagnostics: SoftwareOrchestrationDiagnostics | undefined,
  rejectedFiles: string[]
) {
  if (!diagnostics) return
  diagnostics.rejectedFiles = Array.from(new Set(rejectedFiles.map(normalizePath).filter(Boolean)))
  if (diagnostics.rejectedFiles.length > 0) {
    diagnostics.validationStatus = "failed"
    diagnostics.failedScope = "allowed-scope"
  }
}

export function markPreviewStatus(
  diagnostics: SoftwareOrchestrationDiagnostics | undefined,
  previewStatus: string | null | undefined
) {
  if (!diagnostics) return
  diagnostics.previewStatus = previewStatus || "unknown"
}

export function markCommitStatus(
  diagnostics: SoftwareOrchestrationDiagnostics | undefined,
  commitStatus: SoftwareOrchestrationDiagnostics["commitStatus"]
) {
  if (!diagnostics) return
  diagnostics.commitStatus = commitStatus
}

function buildPlannerOutput(input: {
  prompt: string
  appType: string
  structuredIntent: SwiftStructuredIntent
  architecture: SwiftArchitecturePlan
  blueprintRequiredFiles: string[]
}): PlannerOutput {
  const features = unique([
    ...input.structuredIntent.businessRequirements,
    ...input.structuredIntent.backend.services.map((service) => `${service}_service`),
    ...input.structuredIntent.database.models.map((model) => `${model}_model`),
    input.structuredIntent.auth.provider ? "authentication" : "",
    input.structuredIntent.payments.provider ? "payments" : "",
    input.structuredIntent.storage.provider ? "storage" : "",
  ])
  const requiredRoutes = unique([
    ...input.architecture.frontend.pages,
    ...input.architecture.backend.apiRoutes,
    ...input.architecture.auth.routes,
    ...input.architecture.payments.routes,
  ])
  const requiredModules = unique([
    ...input.architecture.backend.services,
    ...input.architecture.storage.adapters,
    ...input.architecture.payments.services,
    ...input.blueprintRequiredFiles.filter((file) => /^components\//i.test(file)),
  ])
  const requiredComponents = unique(inferComponents(input.architecture, input.structuredIntent).map((component) => component.path))
  const requiredFiles = unique([
    ...requiredRoutes,
    ...requiredModules,
    ...input.blueprintRequiredFiles,
    input.structuredIntent.type === "frontend_only" ? "" : input.architecture.database.schema,
    input.structuredIntent.type === "frontend_only" ? "" : ".env.example",
  ].filter((file) => file && file !== "none"))
  const complexity = scoreComplexity(input.prompt, requiredRoutes, requiredModules)

  return {
    appType: toPlannerAppType(input.structuredIntent.archetype, input.appType),
    confidence: estimateConfidence(input),
    features,
    complexity,
    requiredRoutes,
    requiredComponents,
    requiredFiles,
  }
}

function buildArchitectureOutput(input: {
  architecture: SwiftArchitecturePlan
  dependencyGraph: SwiftDependencyGraph
  plannerOutput: PlannerOutput
  componentGraph: ComponentGraph
}): ArchitectureOutput {
  return {
    archetype: input.plannerOutput.appType,
    requiredRoutes: input.plannerOutput.requiredRoutes,
    requiredComponents: input.plannerOutput.requiredComponents,
    routes: unique([...input.architecture.frontend.pages, ...input.architecture.backend.apiRoutes]),
    components: input.componentGraph.components.map((component) => component.path),
    dependencies: unique([...input.architecture.dependencies, ...input.dependencyGraph.nodes.map((node) => node.id)]),
    requiredFiles: input.plannerOutput.requiredFiles,
    allowedFiles: allowedFilesForPlanner(input.plannerOutput),
    forbiddenPatterns: [
      "../",
      "node_modules/",
      ".env",
      ".git/",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ],
    validationRules: validationRulesForAppType(input.plannerOutput.appType),
  }
}

function buildGraphs(input: {
  structuredIntent: SwiftStructuredIntent
  architecture: SwiftArchitecturePlan
  dependencyGraph: SwiftDependencyGraph
  plannerOutput: PlannerOutput
}): SoftwareOrchestrationGraphs {
  const pageRoutes = input.architecture.frontend.pages.map((path) => ({
    path,
    kind: "page" as const,
    reason: "planned frontend route",
  }))
  const apiRoutes = input.architecture.backend.apiRoutes.map((path) => ({
    path,
    kind: "api" as const,
    reason: "planned API route",
  }))

  return {
    intentGraph: {
      appType: input.plannerOutput.appType,
      archetype: input.structuredIntent.archetype,
      domain: input.structuredIntent.domain,
      features: input.plannerOutput.features,
      requiredRoutes: input.plannerOutput.requiredRoutes,
      requiredComponents: input.plannerOutput.requiredComponents,
      requiredFiles: input.plannerOutput.requiredFiles,
    },
    routeGraph: {
      routes: [...pageRoutes, ...apiRoutes],
    },
    componentGraph: {
      components: inferComponents(input.architecture, input.structuredIntent),
    },
    dependencyGraph: {
      dependencies: input.dependencyGraph.nodes,
      edges: input.dependencyGraph.edges,
      missingBusinessDependencies: input.dependencyGraph.missingBusinessDependencies,
    },
  }
}

function validateGraphsAgainstPlanner(planner: PlannerOutput, graphs: SoftwareOrchestrationGraphs) {
  const failures: string[] = []
  const graphRoutes = new Set(graphs.routeGraph.routes.map((route) => route.path))
  for (const route of planner.requiredRoutes) {
    if (!graphRoutes.has(route)) failures.push(`Planner required route is absent from route graph: ${route}`)
  }

  if (planner.appType === "ecommerce") {
    for (const route of ["app/products/page.tsx", "app/cart/page.tsx", "app/checkout/page.tsx"]) {
      if (planner.requiredRoutes.includes(route) && !graphRoutes.has(route)) {
        failures.push(`Commerce route graph missing ${route}`)
      }
    }
    if (!graphs.componentGraph.components.some((component) => /product/i.test(component.path))) {
      failures.push("Commerce component graph missing product component")
    }
  }

  if (planner.appType === "dashboard") {
    for (const componentName of ["sidebar", "overview", "settings"]) {
      const present =
        planner.requiredRoutes.some((route) => route.toLowerCase().includes(componentName)) ||
        graphs.componentGraph.components.some((component) => component.path.toLowerCase().includes(componentName))
      if (!present) failures.push(`Dashboard architecture missing ${componentName}`)
    }
  }

  if (planner.appType === "landing") {
    for (const componentName of ["hero", "features", "cta", "footer"]) {
      const present = graphs.componentGraph.components.some((component) => component.path.toLowerCase().includes(componentName))
      if (!present) failures.push(`Landing architecture missing ${componentName}`)
    }
  }

  if (planner.requiredRoutes.length === 0) failures.push("Planner produced no required routes")
  if (graphs.componentGraph.components.length === 0) failures.push("Architecture produced no component graph")

  return failures
}

function inferComponents(architecture: SwiftArchitecturePlan, intent: SwiftStructuredIntent) {
  const components = new Map<string, { path: string; ownerRoute?: string | null; reason: string }>()
  const add = (path: string, ownerRoute: string | null, reason: string) => {
    components.set(path, { path, ownerRoute, reason })
  }

  if (intent.type === "frontend_only") {
    add("app/page.tsx", "app/page.tsx", "frontend-only page scope")
    return Array.from(components.values())
  }

  if (intent.archetype === "FULLSTACK_COMMERCE") {
    add("components/Navbar.tsx", "app/page.tsx", "ecommerce navigation")
    add("components/ProductCard.tsx", "app/products/page.tsx", "product listing item")
    add("components/ProductGrid.tsx", "app/products/page.tsx", "product grid")
    add("components/CartDrawer.tsx", "app/cart/page.tsx", "cart drawer")
    add("components/CheckoutForm.tsx", "app/checkout/page.tsx", "checkout form")
    return Array.from(components.values())
  }
  add("components/app-shell.tsx", "app/page.tsx", "shared layout shell")
  if (intent.archetype === "DASHBOARD_SAAS" || intent.archetype === "ADMIN_PANEL") {
    add("components/dashboard-sidebar.tsx", "app/dashboard/page.tsx", "dashboard sidebar")
    add("components/overview-panel.tsx", "app/dashboard/page.tsx", "dashboard overview")
    add("components/settings-panel.tsx", "app/dashboard/settings/page.tsx", "dashboard settings")
  }
  if (intent.archetype === "PORTFOLIO_SITE") {
    add("components/hero-section.tsx", "app/page.tsx", "landing hero")
    add("components/features-section.tsx", "app/page.tsx", "landing features")
    add("components/cta-section.tsx", "app/page.tsx", "landing CTA")
    add("components/site-footer.tsx", "app/page.tsx", "landing footer")
  }
  for (const page of architecture.frontend.pages) {
    const segment = page.replace(/^app\//, "").replace(/\/page\.tsx$/, "").replace(/^page\.tsx$/, "home")
    const safe = segment.replace(/\[[^\]]+\]/g, "detail").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "home"
    add(`components/${safe}-view.tsx`, page, `view component for ${page}`)
  }
  for (const service of intent.backend.services) {
    add(`components/${service}-status.tsx`, null, `UI status boundary for ${service}`)
  }

  return Array.from(components.values())
}

function scoreComplexity(prompt: string, routes: string[], modules: string[]): PlannerComplexity {
  const score =
    Math.ceil(prompt.length / 900) +
    routes.length * 2 +
    modules.length * 2 +
    (/\b(auth|payment|database|prisma|webhook|storage|role|rbac)\b/i.test(prompt) ? 8 : 0)
  if (score >= 24) return "high"
  if (score >= 10) return "medium"
  return "low"
}

function estimateConfidence(input: {
  prompt: string
  structuredIntent: SwiftStructuredIntent
  architecture: SwiftArchitecturePlan
}) {
  let confidence = 0.72
  if (input.structuredIntent.domain !== "custom_web_app") confidence += 0.08
  if (input.structuredIntent.businessRequirements.length > 0) confidence += 0.06
  if (input.architecture.frontend.pages.length > 0) confidence += 0.04
  if (input.architecture.backend.apiRoutes.length > 0 || input.structuredIntent.type === "frontend_only") confidence += 0.04
  if (/\b(app|web|website|dashboard|ecommerce|booking|blog|portfolio|admin|crud|fullstack|full-stack)\b/i.test(input.prompt)) confidence += 0.04
  return Math.max(0, Math.min(0.98, Math.round(confidence * 100) / 100))
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function allowedFilesForPlanner(planner: PlannerOutput) {
  if (planner.appType === "ecommerce") {
    return unique([
      "app/layout.tsx",
      "app/page.tsx",
      "app/globals.css",
      "package.json",
      "tsconfig.json",
      "tailwind.config.ts",
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
      "lib/supabase/client.ts",
      "lib/supabase/server.ts",
      "lib/turso/client.ts",
      "app/api/transactions/route.ts",
    ])
  }

  return unique([
    ...planner.requiredFiles,
    ...planner.requiredRoutes,
    ...planner.requiredComponents,
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "package.json",
    "tsconfig.json",
    "tailwind.config.ts",
  ])
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function toPlannerAppType(archetype: string, appType: string): PlannerOutput["appType"] {
  if (appType === "frontend_landing") return "other"
  if (archetype === "FULLSTACK_COMMERCE" || appType === "simple_marketplace") return "ecommerce"
  if (archetype === "DASHBOARD_SAAS" || archetype === "ADMIN_PANEL" || /dashboard|admin|saas/i.test(appType)) return "dashboard"
  if (archetype === "CONTENT_PLATFORM") return "blog"
  if (archetype === "PORTFOLIO_SITE") return /landing/i.test(appType) ? "landing" : "portfolio"
  if (archetype === "BOOKING_APP") return "saas"
  return "other"
}

function validationRulesForAppType(appType: PlannerOutput["appType"]) {
  if (appType === "ecommerce") {
    return ["product listing exists", "cart exists", "checkout exists", "navigation exists", "product component exists"]
  }
  if (appType === "dashboard") return ["sidebar exists", "overview exists", "settings exists"]
  if (appType === "landing") return ["hero exists", "features exist", "CTA exists", "footer exists"]
  return ["required routes exist", "required components exist", "code compiles", "preview boots"]
}

function classifyIssueType(reason: string) {
  if (/json|schema|artifact|parse generated artifact|malformed/i.test(reason)) return "json_schema"
  if (/architecture|route graph|component graph|intent|required route|blueprint|missing required/i.test(reason)) return "architecture_mismatch"
  if (/layout|spacing|responsive|visual|ui/i.test(reason)) return "ui_layout"
  return "tsx_build"
}

function modelForRepairIssue(issueType: string) {
  if (issueType === "architecture_mismatch") return modelForSoftwareRole("architecture")
  if (issueType === "json_schema") return modelForSoftwareRole("planner")
  if (issueType === "ui_layout") return modelForSoftwareRole("ui_enhancement")
  return modelForSoftwareRole("repair")
}

function fixPlanForIssue(issueType: string) {
  if (issueType === "architecture_mismatch") return "repair only the missing route/component/schema scope without redesigning the app"
  if (issueType === "json_schema") return "return valid JSON matching the required schema only"
  if (issueType === "ui_layout") return "refine only the failing UI scope without business logic changes"
  return "fix syntax, imports, exports, props, or one-file runtime/build failure only"
}

function inferFailedScope(targetFiles: string[], reason: string) {
  if (targetFiles.length === 1) return targetFiles[0]
  if (/scaffold/i.test(reason)) return "scaffold"
  if (/architecture/i.test(reason)) return "architecture"
  if (/preview|runtime/i.test(reason)) return "runtime"
  return targetFiles.length > 0 ? "targeted-files" : "unknown"
}
