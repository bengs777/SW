import type { GeneratedFile } from "@/lib/types"
import type { SwiftArchitecturePlan } from "@/lib/ai/architecture-planner"
import type { SwiftDependencyGraph } from "@/lib/ai/project-memory-graph"

export type ArchitectureValidationDiagnostic = {
  code:
    | "missing_route"
    | "missing_service"
    | "missing_model"
    | "missing_dependency"
    | "missing_env_var"
    | "payment_incomplete"
    | "storage_incomplete"
    | "auth_incomplete"
  message: string
  severity: "error" | "warning"
  data?: Record<string, unknown>
}

export type ArchitectureValidationResult = {
  ok: boolean
  diagnostics: ArchitectureValidationDiagnostic[]
}

export function validateArchitectureFiles(input: {
  files: GeneratedFile[]
  architecturePlan: SwiftArchitecturePlan
  dependencyGraph: SwiftDependencyGraph
}): ArchitectureValidationResult {
  const files = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const paths = new Set(files.map((file) => file.path))
  const packageJson = parsePackageJson(files)
  const prismaModels = extractPrismaModels(files)
  const envVars = extractEnvVars(files)
  const diagnostics: ArchitectureValidationDiagnostic[] = []

  for (const route of input.architecturePlan.backend.apiRoutes) {
    if (!paths.has(normalizePath(route))) {
      diagnostics.push({
        code: "missing_route",
        severity: "error",
        message: `Missing planned API route: ${route}`,
      })
    }
  }
  for (const service of [...input.architecturePlan.backend.services, ...input.architecturePlan.payments.services, ...input.architecturePlan.storage.adapters]) {
    if (service && !paths.has(normalizePath(service))) {
      diagnostics.push({
        code: "missing_service",
        severity: "error",
        message: `Missing planned service or adapter: ${service}`,
      })
    }
  }
  for (const model of input.architecturePlan.database.models) {
    if (!prismaModels.some((existing) => existing.toLowerCase() === singularModel(model).toLowerCase())) {
      diagnostics.push({
        code: "missing_model",
        severity: "error",
        message: `Missing planned Prisma model: ${model}`,
      })
    }
  }
  for (const dependency of input.architecturePlan.dependencies) {
    if (dependency === "tailwindcss") continue
    if (!packageJson.dependencies[dependency] && !packageJson.devDependencies[dependency]) {
      diagnostics.push({
        code: "missing_dependency",
        severity: dependency === "typescript" ? "warning" : "error",
        message: `Missing package dependency: ${dependency}`,
      })
    }
  }
  for (const envVar of input.architecturePlan.requiredEnvVars) {
    if (!envVars.includes(envVar)) {
      diagnostics.push({
        code: "missing_env_var",
        severity: "warning",
        message: `Missing env var reference or .env.example placeholder: ${envVar}`,
      })
    }
  }
  if (input.architecturePlan.payments.provider && input.architecturePlan.payments.routes.some((route) => !paths.has(route))) {
    diagnostics.push({
      code: "payment_incomplete",
      severity: "error",
      message: `Payment provider ${input.architecturePlan.payments.provider} requires checkout and webhook routes.`,
    })
  }
  if (input.architecturePlan.storage.provider && input.architecturePlan.storage.adapters.length > 0 && input.architecturePlan.storage.adapters.every((adapter) => !paths.has(adapter))) {
    diagnostics.push({
      code: "storage_incomplete",
      severity: "error",
      message: `Storage provider ${input.architecturePlan.storage.provider} requires a server-side adapter.`,
    })
  }
  if (input.architecturePlan.auth.provider && input.architecturePlan.auth.routes.some((route) => !paths.has(route))) {
    diagnostics.push({
      code: "auth_incomplete",
      severity: "warning",
      message: `Auth provider ${input.architecturePlan.auth.provider} should expose a session route boundary.`,
    })
  }
  for (const missing of input.dependencyGraph.missingBusinessDependencies) {
    diagnostics.push({
      code: "missing_model",
      severity: "error",
      message: `Missing business dependency from graph: ${missing}`,
      data: { missing },
    })
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics,
  }
}

function parsePackageJson(files: Array<{ path: string; content: string }>) {
  const file = files.find((item) => item.path === "package.json")
  if (!file) return { dependencies: {} as Record<string, string>, devDependencies: {} as Record<string, string> }
  try {
    const parsed = JSON.parse(file.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return {
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
    }
  } catch {
    return { dependencies: {} as Record<string, string>, devDependencies: {} as Record<string, string> }
  }
}

function extractPrismaModels(files: Array<{ path: string; content: string }>) {
  const schema = files.find((file) => file.path === "prisma/schema.prisma")?.content || ""
  return Array.from(new Set(Array.from(schema.matchAll(/\bmodel\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)).map((match) => match[1])))
}

function extractEnvVars(files: Array<{ path: string; content: string }>) {
  const vars = new Set<string>()
  for (const file of files) {
    if (file.path === ".env.example") {
      for (const line of file.content.split(/\r?\n/)) {
        const name = line.split("=")[0]?.trim()
        if (/^[A-Z0-9_]+$/.test(name)) vars.add(name)
      }
    }
    for (const match of file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      vars.add(match[1])
    }
    for (const match of file.content.matchAll(/env\(["']([A-Z0-9_]+)["']\)/g)) {
      vars.add(match[1])
    }
  }
  return Array.from(vars)
}

function singularModel(value: string) {
  const normalized = String(value || "")
  return normalized.endsWith("s") ? normalized.slice(0, -1) : normalized
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}
