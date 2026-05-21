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
  appType: string
  confidence: number
  features: string[]
  complexity: PlannerComplexity
  requiredRoutes: string[]
  requiredModules: string[]
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
  requiredModules: string[]
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
    targetFiles: string[]
    reason: string
  }>
  plannerOutput: PlannerOutput
  graphs: SoftwareOrchestrationGraphs
  validation: {
    ok: boolean
    failures: string[]
  }
}

export const SOFTWARE_ORCHESTRATION_PIPELINE = [
  "Intent Planning",
  "Architecture Planning",
  "Intent Graph Generation",
  "Route Graph Generation",
  "Component Graph Generation",
  "Scaffold Generation",
  "Scoped File Generation",
  "Runtime Validation",
  "Targeted Repair",
  "Preview Boot",
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
    graphs,
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
  }
) {
  if (!diagnostics) return
  diagnostics.repairPath.push({
    attempt: input.attempt,
    model: modelForSoftwareRole("repair"),
    targetFiles: input.targetFiles,
    reason: input.reason,
  })
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
  const complexity = scoreComplexity(input.prompt, requiredRoutes, requiredModules)

  return {
    appType: input.structuredIntent.archetype || input.appType,
    confidence: estimateConfidence(input),
    features,
    complexity,
    requiredRoutes,
    requiredModules,
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
      requiredModules: input.plannerOutput.requiredModules,
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

  if (planner.appType === "FULLSTACK_COMMERCE") {
    for (const route of ["app/products/page.tsx", "app/cart/page.tsx"]) {
      if (planner.requiredRoutes.includes(route) && !graphRoutes.has(route)) {
        failures.push(`Commerce route graph missing ${route}`)
      }
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

  add("components/app-shell.tsx", "app/page.tsx", "shared layout shell")
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
