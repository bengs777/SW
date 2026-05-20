import type { GeneratedFile } from "@/lib/types"
import type { SwiftArchitecturePlan } from "@/lib/ai/architecture-planner"
import type { SwiftStructuredIntent } from "@/lib/ai/architecture-intent"

export type SwiftProjectMemoryGraph = {
  mode: "project-memory-graph-v1"
  framework: string | null
  routes: string[]
  components: string[]
  imports: Array<{ file: string; specifier: string }>
  databaseModels: string[]
  installedDependencies: string[]
  services: string[]
  authProviders: string[]
  paymentProviders: string[]
  storageAdapters: string[]
  envVars: string[]
  lastIntent?: SwiftStructuredIntent
  lastArchitecturePlan?: SwiftArchitecturePlan
  updatedAt: string
}

export type SwiftDependencyGraph = {
  mode: "architecture-dependency-graph-v1"
  nodes: Array<{ id: string; kind: "frontend" | "api" | "db" | "auth" | "payment" | "storage" | "service" | "env" }>
  edges: Array<{ from: string; to: string; reason: string }>
  missingBusinessDependencies: string[]
}

export function buildProjectMemoryGraph(input: {
  files: GeneratedFile[]
  intent?: SwiftStructuredIntent
  architecturePlan?: SwiftArchitecturePlan
}): SwiftProjectMemoryGraph {
  const files = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const packageJson = parsePackageJson(files)

  return {
    mode: "project-memory-graph-v1",
    framework: detectFramework(packageJson, files),
    routes: files.filter((file) => /^app\/.+\/(page|route)\.(tsx?|jsx?)$/i.test(file.path) || /^app\/page\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path).sort(),
    components: files.filter((file) => /^components\/.+\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path).sort(),
    imports: extractImports(files),
    databaseModels: extractPrismaModels(files),
    installedDependencies: Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).sort(),
    services: files.filter((file) => /^lib\/services\/.+\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path).sort(),
    authProviders: detectProviderList(files, input.intent?.auth.provider),
    paymentProviders: detectProviderList(files, input.intent?.payments.provider),
    storageAdapters: files.filter((file) => /^lib\/(storage|supabase)\//i.test(file.path)).map((file) => file.path).sort(),
    envVars: unique([...extractEnvVars(files), ...(input.architecturePlan?.requiredEnvVars || [])]).sort(),
    lastIntent: input.intent,
    lastArchitecturePlan: input.architecturePlan,
    updatedAt: new Date().toISOString(),
  }
}

export function buildArchitectureDependencyGraph(input: {
  intent: SwiftStructuredIntent
  architecturePlan: SwiftArchitecturePlan
  memory: SwiftProjectMemoryGraph
}): SwiftDependencyGraph {
  const nodes = new Map<string, SwiftDependencyGraph["nodes"][number]>()
  const edges: SwiftDependencyGraph["edges"] = []
  const missing = new Set<string>()
  const addNode = (id: string, kind: SwiftDependencyGraph["nodes"][number]["kind"]) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind })
  }
  const addEdge = (from: string, to: string, reason: string) => {
    edges.push({ from, to, reason })
  }

  addNode("frontend", "frontend")
  for (const route of input.architecturePlan.backend.apiRoutes) {
    addNode(route, "api")
    addEdge("frontend", route, "frontend calls API route")
  }
  for (const service of input.architecturePlan.backend.services) {
    addNode(service, "service")
    for (const route of input.architecturePlan.backend.apiRoutes) {
      addEdge(route, service, "route delegates business logic to service")
    }
  }
  for (const model of input.architecturePlan.database.models) {
    const id = `model:${model}`
    addNode(id, "db")
    for (const service of input.architecturePlan.backend.services) {
      addEdge(service, id, "service persists domain model")
    }
    if (!input.memory.databaseModels.some((existing) => existing.toLowerCase() === singularModel(model).toLowerCase())) {
      missing.add(`missing_model:${model}`)
    }
  }
  if (input.intent.payments.provider) {
    addNode(`payment:${input.intent.payments.provider}`, "payment")
    addEdge("frontend", "app/api/payments/checkout/route.ts", "checkout UI starts payment session")
    addEdge("app/api/payments/checkout/route.ts", `payment:${input.intent.payments.provider}`, "payment route calls provider")
    if (!input.architecturePlan.database.models.includes("orders")) missing.add("missing_model:orders")
  }
  if (input.intent.storage.provider) {
    addNode(`storage:${input.intent.storage.provider}`, "storage")
    for (const adapter of input.architecturePlan.storage.adapters) addEdge(adapter, `storage:${input.intent.storage.provider}`, "adapter writes to object storage")
  }
  if (input.intent.auth.provider) {
    addNode(`auth:${input.intent.auth.provider}`, "auth")
    for (const route of input.architecturePlan.auth.routes) addEdge(route, `auth:${input.intent.auth.provider}`, "auth route owns session provider")
  }
  for (const envVar of input.architecturePlan.requiredEnvVars) {
    addNode(`env:${envVar}`, "env")
  }

  return {
    mode: "architecture-dependency-graph-v1",
    nodes: Array.from(nodes.values()),
    edges,
    missingBusinessDependencies: Array.from(missing).sort(),
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

function detectFramework(packageJson: { dependencies: Record<string, string>; devDependencies: Record<string, string> }, files: Array<{ path: string }>) {
  if (packageJson.dependencies.next || packageJson.devDependencies.next || files.some((file) => file.path.startsWith("app/"))) return "nextjs"
  return null
}

function extractPrismaModels(files: Array<{ path: string; content: string }>) {
  const schema = files.find((file) => file.path === "prisma/schema.prisma")?.content || ""
  return unique(Array.from(schema.matchAll(/\bmodel\s+([A-Z][A-Za-z0-9_]*)\s*\{/g)).map((match) => match[1]))
}

function extractEnvVars(files: Array<{ content: string }>) {
  const vars = new Set<string>()
  for (const file of files) {
    for (const match of file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      vars.add(match[1])
    }
    for (const match of file.content.matchAll(/env\(["']([A-Z0-9_]+)["']\)/g)) {
      vars.add(match[1])
    }
  }
  return Array.from(vars)
}

function extractImports(files: Array<{ path: string; content: string }>) {
  const imports: Array<{ file: string; specifier: string }> = []
  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/i.test(file.path)) continue
    for (const match of file.content.matchAll(/\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g)) {
      imports.push({ file: file.path, specifier: match[1] })
    }
  }
  return imports.slice(0, 300)
}

function detectProviderList(files: Array<{ content: string }>, explicit?: string | null) {
  const values = new Set<string>()
  if (explicit) values.add(explicit)
  const content = files.map((file) => file.content).join("\n").toLowerCase()
  for (const provider of ["nextauth", "midtrans", "stripe", "xendit", "pakasir", "cloudflare_r2", "turso", "supabase"]) {
    if (content.includes(provider.replace("_", " ")) || content.includes(provider)) values.add(provider)
  }
  return Array.from(values).sort()
}

function singularModel(value: string) {
  const normalized = String(value || "")
  return normalized.endsWith("s") ? normalized.slice(0, -1) : normalized
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}
