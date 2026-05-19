import type { GeneratedFile } from "@/lib/types"
import type { GeneratedTaskGraph, GeneratedTaskOperation } from "@/lib/ai/generated-artifact"
import { normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
import { PACKAGE_DEV_DEPENDENCIES, PACKAGE_VERSION_ALLOWLIST } from "@/lib/ai/generation-pipeline"
import { normalizeFileLanguage } from "@/lib/workspace-state"

type TaskGraphExecutionResult = {
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  deletedPaths: string[]
  installedDependencies: string[]
}

const PACKAGE_JSON_PATH = "package.json"
const MAX_OPERATIONS = 100
const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 200 * 1024

export function executeGeneratedTaskGraph(
  currentFiles: GeneratedFile[],
  taskGraph: GeneratedTaskGraph | null | undefined,
  fallbackFiles: GeneratedFile[] = [],
  fallbackDependencies: string[] = []
): TaskGraphExecutionResult {
  const byPath = new Map<string, GeneratedFile>()
  for (const file of currentFiles) {
    byPath.set(normalizeGeneratedPath(file.path), normalizeGeneratedFile(file))
  }

  const operations = collapseOperations(taskGraph?.operations?.length
    ? taskGraph.operations
    : fallbackFiles.map((file): GeneratedTaskOperation => ({
        action: byPath.has(normalizeGeneratedPath(file.path)) ? "modify" : "create",
        path: file.path,
        content: file.content,
        language: file.language,
      })))

  const changedPaths = new Set<string>()
  const deletedPaths: string[] = []

  for (const operation of operations) {
    const path = normalizeGeneratedPath(operation.path)
    if (!path) continue

    if (operation.action === "delete") {
      if (byPath.delete(path)) {
        changedPaths.add(path)
        deletedPaths.push(path)
      }
      continue
    }

    const content = typeof operation.content === "string" ? operation.content : byPath.get(path)?.content ?? ""
    byPath.set(path, {
      path,
      content,
      language: operation.language || inferLanguageFromPath(path),
    })
    changedPaths.add(path)
    assertResourceLimits(Array.from(byPath.values()), operations.length)
  }

  const dependencies = normalizeDependencies([
    ...(taskGraph?.dependencies || []),
    ...fallbackDependencies,
  ])
  if (dependencies.length > 0) {
    const packageFile = installDependencies(byPath.get(PACKAGE_JSON_PATH), dependencies)
    byPath.set(PACKAGE_JSON_PATH, packageFile)
    changedPaths.add(PACKAGE_JSON_PATH)
  }

  const files = Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))
  assertResourceLimits(files, operations.length)

  return {
    files,
    changedFiles: files.filter((file) => changedPaths.has(normalizeGeneratedPath(file.path))),
    deletedPaths,
    installedDependencies: dependencies,
  }
}

function installDependencies(packageFile: GeneratedFile | undefined, dependencies: string[]): GeneratedFile {
  const packageJson = parsePackageJson(packageFile?.content) as Record<string, unknown> & {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    scripts: Record<string, string>
  }
  packageJson.dependencies = normalizeRecord(packageJson.dependencies)

  for (const dependency of dependencies) {
    const parsed = parseDependency(dependency)
    if (!parsed.name) continue
    const allowedVersion = PACKAGE_VERSION_ALLOWLIST[parsed.name]
    if (!allowedVersion) {
      throw new Error(`Dependency is not allowed by Swift policy: ${parsed.name}`)
    }
    if (!packageJson.dependencies[parsed.name]) {
      packageJson.dependencies[parsed.name] = allowedVersion
    }
  }

  packageJson.devDependencies = normalizeRecord(packageJson.devDependencies)
  for (const dependency of dependencies) {
    const parsed = parseDependency(dependency)
    if (!parsed.name || !PACKAGE_DEV_DEPENDENCIES.has(parsed.name)) continue
    delete packageJson.dependencies[parsed.name]
    packageJson.devDependencies[parsed.name] = PACKAGE_VERSION_ALLOWLIST[parsed.name]
  }

  packageJson.scripts = {
    dev: "next dev",
    build: "next build",
    start: "next start",
    ...(normalizeRecord(packageJson.scripts)),
  }

  return {
    path: PACKAGE_JSON_PATH,
    language: "json",
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
  }
}

function parseDependency(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return { name: "", version: "" }
  if (trimmed.startsWith("@")) {
    const parts = trimmed.split("@")
    return {
      name: `@${parts[1] || ""}`,
      version: parts.slice(2).join("@") || "",
    }
  }

  const [name, ...versionParts] = trimmed.split("@")
  return {
    name: name || "",
    version: versionParts.join("@"),
  }
}

function normalizeDependencies(dependencies: string[]) {
  return Array.from(
    new Set(
      dependencies
        .map((dependency) => dependency.trim())
        .filter(Boolean)
        .filter((dependency) => !dependency.startsWith(".") && !dependency.startsWith("/"))
        .map((dependency) => {
          const parsed = parseDependency(dependency)
          if (!parsed.name || !PACKAGE_VERSION_ALLOWLIST[parsed.name]) {
            throw new Error(`Dependency is not allowed by Swift policy: ${parsed.name || dependency}`)
          }
          return parsed.name
        })
    )
  ).sort()
}

function parsePackageJson(content: string | null | undefined) {
  try {
    const parsed = JSON.parse(String(content || "{}")) as Record<string, unknown>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        ...parsed,
        scripts: normalizeRecord(parsed.scripts),
        dependencies: normalizeRecord(parsed.dependencies),
      }
    }
  } catch {
    // Use a safe minimal package.json.
  }

  return {
    name: "swift-generated-app",
    private: true,
    version: "0.1.0",
    scripts: {},
    dependencies: {},
  }
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].trim().length > 0)
      .map(([key, recordValue]) => [key.trim(), recordValue.trim()])
  )
}

function normalizeGeneratedFile(file: GeneratedFile): GeneratedFile {
  const path = validateGeneratedPath(file.path, process.cwd(), { allowManagedPackageJson: true }).path
  return {
    path,
    content: String(file.content ?? ""),
    language: normalizeFileLanguage(file.language) || inferLanguageFromPath(path),
  }
}

function collapseOperations(operations: GeneratedTaskOperation[]) {
  if (operations.length > MAX_OPERATIONS) {
    throw new Error(`Too many task graph operations. Maximum: ${MAX_OPERATIONS}`)
  }

  const byPath = new Map<string, GeneratedTaskOperation>()
  const createdPaths = new Set<string>()

  for (const operation of operations) {
    const path = validateGeneratedPath(operation.path).path
    if (!path) continue
    if (operation.action === "create") {
      createdPaths.add(path)
    }

    const previous = byPath.get(path)
    const action =
      operation.action === "delete"
        ? "delete"
        : createdPaths.has(path) || previous?.action === "create"
          ? "create"
          : operation.action
    byPath.set(path, {
      ...operation,
      action,
      path,
      language: operation.language || inferLanguageFromPath(path),
    })
  }

  return Array.from(byPath.values())
}

function assertResourceLimits(files: GeneratedFile[], operationCount: number) {
  if (operationCount > MAX_OPERATIONS) {
    throw new Error(`Too many task graph operations. Maximum: ${MAX_OPERATIONS}`)
  }

  let totalBytes = 0
  for (const file of files) {
    const size = Buffer.byteLength(String(file.content ?? ""), "utf8")
    if (size > MAX_FILE_BYTES) {
      throw new Error(`Generated file ${file.path} exceeds ${MAX_FILE_BYTES} bytes.`)
    }
    totalBytes += size
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Generated files exceed ${MAX_TOTAL_BYTES} bytes.`)
    }
  }
}

function inferLanguageFromPath(path: string): GeneratedFile["language"] {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  if (path.endsWith(".html")) return "html"
  if (path.endsWith(".prisma")) return "prisma"
  if (path.endsWith(".md")) return "md"
  if (path.endsWith(".env")) return "env"
  return "ts"
}
