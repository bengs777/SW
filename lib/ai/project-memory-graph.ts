import type { GeneratedFile } from "@/lib/types"
import type { SwiftArchitecturePlan } from "@/lib/ai/architecture-planner"
import type { SwiftStructuredIntent } from "@/lib/ai/architecture-intent"

export type SwiftProjectMemoryGraph = {
  mode: "project-memory-graph-v1"
  framework: string | null
  routes: string[]
  routeGraph: Array<{ path: string; kind: "page" | "api"; route: string; imports: string[] }>
  components: string[]
  componentGraph: Array<{ path: string; exports: string[]; imports: string[]; hooks: string[]; props: string[] }>
  imports: Array<{ file: string; specifier: string }>
  databaseModels: string[]
  installedDependencies: string[]
  services: string[]
  serviceGraph: Array<{ path: string; exports: string[]; imports: string[]; models: string[] }>
  apiGraph: Array<{ path: string; methods: string[]; services: string[]; models: string[] }>
  dependencies: Array<{ file: string; imports: string[]; importedBy: string[] }>
  snapshotId: string
  authProviders: string[]
  paymentProviders: string[]
  storageAdapters: string[]
  envVars: string[]
  lastIntent?: SwiftStructuredIntent
  lastArchitecturePlan?: SwiftArchitecturePlan
  previousSnapshotId?: string | null
  previousUpdatedAt?: string | null
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
  previousMemoryJson?: string | null
}): SwiftProjectMemoryGraph {
  const files = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: String(file.content || ""),
  }))
  const packageJson = parsePackageJson(files)
  const imports = extractImports(files)
  const componentGraph = buildComponentGraph(files)
  const serviceGraph = buildServiceGraph(files)
  const apiGraph = buildApiGraph(files)
  const routeGraph = buildRouteGraph(files, imports)
  const dependencyGraph = buildFileDependencyGraph(files, imports)
  const snapshotId = createArchitectureSnapshotId(files)
  const previousMemory = parseProjectMemoryGraph(input.previousMemoryJson)

  return {
    mode: "project-memory-graph-v1",
    framework: detectFramework(packageJson, files),
    routes: routeGraph.map((route) => route.path).sort(),
    routeGraph,
    components: files.filter((file) => /^components\/.+\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path).sort(),
    componentGraph,
    imports,
    databaseModels: extractPrismaModels(files),
    installedDependencies: Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).sort(),
    services: files.filter((file) => /^lib\/services\/.+\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path).sort(),
    serviceGraph,
    apiGraph,
    dependencies: dependencyGraph,
    snapshotId,
    authProviders: detectProviderList(files, input.intent?.auth.provider),
    paymentProviders: detectProviderList(files, input.intent?.payments.provider),
    storageAdapters: files.filter((file) => /^lib\/(storage|supabase)\//i.test(file.path)).map((file) => file.path).sort(),
    envVars: unique([...extractEnvVars(files), ...(input.architecturePlan?.requiredEnvVars || [])]).sort(),
    lastIntent: input.intent,
    lastArchitecturePlan: input.architecturePlan,
    previousSnapshotId: previousMemory?.snapshotId || null,
    previousUpdatedAt: previousMemory?.updatedAt || null,
    updatedAt: new Date().toISOString(),
  }
}

export function buildPersistentArchitectureSnapshot(input: {
  files: GeneratedFile[]
  intent?: SwiftStructuredIntent
  architecturePlan?: SwiftArchitecturePlan
  previousMemoryJson?: string | null
}) {
  const memory = buildProjectMemoryGraph(input)
  return {
    ...memory,
    persistedAt: new Date().toISOString(),
    diagnostics: {
      routeCount: memory.routeGraph.length,
      componentCount: memory.componentGraph.length,
      serviceCount: memory.serviceGraph.length,
      apiCount: memory.apiGraph.length,
      dependencyCount: memory.dependencies.reduce((sum, item) => sum + item.imports.length, 0),
    },
  }
}

export function parseProjectMemoryGraph(value?: string | null): SwiftProjectMemoryGraph | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<SwiftProjectMemoryGraph>
    return parsed?.mode === "project-memory-graph-v1" ? parsed as SwiftProjectMemoryGraph : null
  } catch {
    return null
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

function buildRouteGraph(files: Array<{ path: string; content: string }>, imports: Array<{ file: string; specifier: string }>) {
  return files
    .filter((file) => /^app\/.+\/(page|route)\.(tsx?|jsx?)$/i.test(file.path) || /^app\/page\.(tsx?|jsx?)$/i.test(file.path))
    .map((file) => ({
      path: file.path,
      kind: /\/route\.(tsx?|jsx?)$/i.test(file.path) ? "api" as const : "page" as const,
      route: routePathForAppFile(file.path),
      imports: imports.filter((item) => item.file === file.path).map((item) => item.specifier).sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function buildComponentGraph(files: Array<{ path: string; content: string }>) {
  return files
    .filter((file) => /^components\/.+\.(tsx?|jsx?)$/i.test(file.path) || /^app\/.+\/page\.(tsx?|jsx?)$/i.test(file.path) || /^app\/page\.(tsx?|jsx?)$/i.test(file.path))
    .map((file) => ({
      path: file.path,
      exports: extractExportedSymbols(file.content),
      imports: extractImports([file]).map((item) => item.specifier).sort(),
      hooks: unique(Array.from(file.content.matchAll(/\b(use[A-Z][A-Za-z0-9_]*)\s*\(/g)).map((match) => match[1])).sort(),
      props: unique(Array.from(file.content.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)).map((match) => match[1])).slice(0, 40).sort(),
    }))
}

function buildServiceGraph(files: Array<{ path: string; content: string }>) {
  const models = extractPrismaModels(files)
  return files
    .filter((file) => /^lib\/services\/.+\.(tsx?|jsx?)$/i.test(file.path))
    .map((file) => ({
      path: file.path,
      exports: extractExportedSymbols(file.content),
      imports: extractImports([file]).map((item) => item.specifier).sort(),
      models: models.filter((model) => new RegExp(`\\b${model}\\b`, "i").test(file.content)).sort(),
    }))
}

function buildApiGraph(files: Array<{ path: string; content: string }>) {
  const serviceFiles = files.filter((file) => /^lib\/services\/.+\.(tsx?|jsx?)$/i.test(file.path)).map((file) => file.path)
  const models = extractPrismaModels(files)
  return files
    .filter((file) => /^app\/api\/.+\/route\.(tsx?|jsx?)$/i.test(file.path))
    .map((file) => ({
      path: file.path,
      methods: unique(Array.from(file.content.matchAll(/\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)).map((match) => match[1])).sort(),
      services: serviceFiles.filter((service) => file.content.includes(service.replace(/\.(tsx?|jsx?)$/i, "")) || file.content.includes(service.split("/").pop()?.replace(/\.(tsx?|jsx?)$/i, "") || "")).sort(),
      models: models.filter((model) => new RegExp(`\\b${model}\\b`, "i").test(file.content)).sort(),
    }))
}

function buildFileDependencyGraph(files: Array<{ path: string; content: string }>, imports: Array<{ file: string; specifier: string }>) {
  const paths = new Set(files.map((file) => file.path))
  const resolved = imports
    .map((item) => ({ file: item.file, target: resolveLocalImport(item.file, item.specifier, paths) }))
    .filter((item): item is { file: string; target: string } => Boolean(item.target))
  return files.map((file) => ({
    file: file.path,
    imports: unique(resolved.filter((item) => item.file === file.path).map((item) => item.target)).sort(),
    importedBy: unique(resolved.filter((item) => item.target === file.path).map((item) => item.file)).sort(),
  })).sort((a, b) => a.file.localeCompare(b.file))
}

function extractExportedSymbols(content: string) {
  return unique([
    ...Array.from(content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)).map((match) => match[1]),
    ...Array.from(content.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)).map((match) => match[1]),
    ...Array.from(content.matchAll(/\bexport\s+\{\s*([^}]+)\s*\}/g)).flatMap((match) => match[1].split(",").map((item) => item.trim().split(/\s+as\s+/i).pop() || "")),
  ]).sort()
}

function resolveLocalImport(fromFile: string, specifier: string, paths: Set<string>) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null
  const base = specifier.startsWith("@/")
    ? specifier.slice(2)
    : `${fromFile.split("/").slice(0, -1).join("/")}/${specifier}`
  const normalized = normalizePath(base)
  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
  ]
  return candidates.find((candidate) => paths.has(candidate)) || null
}

function routePathForAppFile(path: string) {
  const normalized = normalizePath(path)
    .replace(/^app/, "")
    .replace(/\/(?:page|route)\.(tsx?|jsx?)$/i, "")
    .replace(/\(([^)]+)\)\//g, "")
    .replace(/\/index$/i, "")
  return normalized || "/"
}

function createArchitectureSnapshotId(files: Array<{ path: string; content: string }>) {
  const seed = files
    .map((file) => `${file.path}:${file.content.length}:${simpleHash(file.content)}`)
    .sort()
    .join("|")
  return `arch_${simpleHash(seed)}`
}

function simpleHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
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
