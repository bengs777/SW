import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { formatGeneratedPathValidationError, normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
import { isValidatorDiagnosticPayload, parseRuntimeMessage } from "@/lib/ai/runtime-contracts"
import { normalizeFileLanguage } from "@/lib/workspace-state"

const MAX_GENERATED_FILES = 100
const MAX_SINGLE_FILE_BYTES = 200 * 1024
const PROTECTED_DELETE_FILES = new Set([
  "app/layout.tsx",
  "app/page.tsx",
])

const artifactMetadataSchema = z.record(z.unknown())

const generatedPathSchema = z.string().trim().min(1).transform((path, ctx) => {
  try {
    return validateGeneratedPath(path).path
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: JSON.stringify(formatGeneratedPathValidationError(error)),
    })
    return z.NEVER
  }
})

const generatedFileSchema = z.object({
  kind: z.enum(["file", "filesystem_write"]).optional().default("file"),
  path: generatedPathSchema,
  content: z.string().refine(
    (content) => Buffer.byteLength(content, "utf8") <= MAX_SINGLE_FILE_BYTES,
    "generated file exceeds single-file size limit"
  ),
  language: z.string().trim().optional(),
}).strict()

const runtimeCommandSchema = z.object({
  kind: z.literal("runtime_command").optional().default("runtime_command"),
  label: z.string().trim().min(1),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional().default([]),
}).strict()

const dependencySchema = z.string().trim().min(1)

const taskGraphOperationSchema = z.object({
  id: z.string().trim().min(1).optional(),
  action: z.enum(["create", "modify", "delete", "patch"]).optional(),
  operation: z.enum(["createFile", "modifyFile", "deleteFile", "patchFile", "create", "modify", "delete", "patch"]).optional(),
  path: generatedPathSchema.optional(),
  file: generatedPathSchema.optional(),
  content: z.string().optional(),
  changes: z.array(z.object({
    line: z.number().int().positive(),
    replace: z.string(),
  }).strict()).optional(),
  language: z.string().trim().optional(),
  reason: z.string().optional(),
}).strict().transform((operation) => {
  const rawAction = operation.action || operation.operation || "modify"
  const action =
    rawAction === "createFile"
      ? "create"
      : rawAction === "modifyFile"
        ? "modify"
        : rawAction === "deleteFile"
          ? "delete"
          : rawAction === "patchFile"
            ? "patch"
            : rawAction

  return {
    ...operation,
    action,
    path: operation.file || operation.path || "",
  }
}).superRefine((operation, ctx) => {
  const path = normalizeGeneratedPath(operation.path)

  if (!path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "operation requires path or file",
      path: ["path"],
    })
  }

  if ((operation.action === "create" || operation.action === "modify") && typeof operation.content !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "create/modify operation requires full content",
      path: ["content"],
    })
  }

  if (operation.action === "patch" && (!operation.changes || operation.changes.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "patch operation requires non-empty line changes",
      path: ["changes"],
    })
  }

  if (operation.action === "delete" && PROTECTED_DELETE_FILES.has(path)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `protected file cannot be deleted: ${path}`,
      path: ["path"],
    })
  }
})

const taskGraphSchema = z.object({
  intent: z.string().optional(),
  summary: z.string().optional(),
  dependencies: z.array(dependencySchema).optional().default([]),
  operations: z.array(taskGraphOperationSchema).max(MAX_GENERATED_FILES),
}).strict()

const generatedArtifactSchema = z.object({
  kind: z.literal("generated_project_artifact").optional().default("generated_project_artifact"),
  framework: z.string().trim().min(1).optional(),
  files: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).default([]),
  dependencies: z.array(dependencySchema).optional().default([]),
  commands: z.array(runtimeCommandSchema).optional().default([]),
  summary: z.string().optional().default(""),
  diagnostics: z.array(z.string()).optional().default([]),
  metadata: artifactMetadataSchema.optional().default({}),
  repairs: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).optional().default([]),
  taskGraph: taskGraphSchema.optional(),
}).strict().superRefine((artifact, ctx) => {
  const filePaths = new Set<string>()
  for (const [index, file] of artifact.files.entries()) {
    const path = normalizeGeneratedPath(file.path)
    if (filePaths.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate file path: ${path}`,
        path: ["files", index, "path"],
      })
    }
    filePaths.add(path)
  }

  if (artifact.commands.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "runtime commands are metadata only and are not accepted as executable artifacts",
      path: ["commands"],
    })
  }

  if (artifact.files.length === 0 && !artifact.taskGraph) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "artifact requires filesystem writes in files or taskGraph.operations",
      path: ["files"],
    })
  }
})

export type GeneratedArtifact = {
  files: GeneratedFile[]
  dependencies: string[]
  commands: []
  summary: string
  diagnostics: string[]
  metadata: Record<string, unknown>
  repairs: GeneratedFile[]
  taskGraph?: GeneratedTaskGraph
}

export type GeneratedTaskGraph = {
  intent?: string
  summary?: string
  dependencies: string[]
  operations: GeneratedTaskOperation[]
}

export type GeneratedTaskOperation = {
  id?: string
  action: "create" | "modify" | "delete" | "patch"
  path: string
  content?: string
  changes?: Array<{ line: number; replace: string }>
  language?: GeneratedFile["language"]
  reason?: string
}

export type GeneratedArtifactParseOptions = {
  requiredFiles?: string[]
  strictFilesOnly?: boolean
  requireTaskGraph?: boolean
  strictJsonEnvelope?: boolean
  recoverJson?: boolean
}

export function parseGeneratedArtifact(
  providerMessage: string,
  options: GeneratedArtifactParseOptions = {}
): GeneratedArtifact {
  const parsedJson = tryParseJson(providerMessage, {
    strictEnvelope: options.strictJsonEnvelope,
    recoverJson: options.recoverJson,
  })
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const runtimeMessage = parseRuntimeMessage(parsedJson)
    if (runtimeMessage && runtimeMessage.kind !== "artifact") {
      throw new Error(`MALFORMED_GENERATED_ARTIFACT:runtime-message:${runtimeMessage.kind}`)
    }

    if (isValidatorDiagnosticPayload(parsedJson)) {
      throw new Error("MALFORMED_GENERATED_ARTIFACT:diagnostic-payload")
    }

    const strict = generatedArtifactSchema.safeParse(parsedJson)
    if (strict.success) {
      if (options.requireTaskGraph && !strict.data.taskGraph) {
        throw new Error("MALFORMED_GENERATED_ARTIFACT:Missing required taskGraph.operations")
      }
      if (options.strictFilesOnly && strict.data.files.length === 0) {
        throw new Error("MALFORMED_GENERATED_ARTIFACT:Empty files array")
      }
      if (options.strictFilesOnly && strict.data.taskGraph) {
        throw new Error("MALFORMED_GENERATED_ARTIFACT:Unsupported artifact structure: BUILD output must use only {\"files\":[...]}")
      }
      assertRequiredFiles(strict.data.files.map((file) => file.path), options.requiredFiles)
      const artifact = {
        files: strict.data.files.map(toGeneratedFile),
        dependencies: strict.data.dependencies,
        commands: [] as [],
        summary: strict.data.summary,
        diagnostics: strict.data.diagnostics,
        metadata: normalizeArtifactMetadata(strict.data.metadata, strict.data.framework),
        repairs: strict.data.repairs.map(toGeneratedFile),
        taskGraph: strict.data.taskGraph ? toGeneratedTaskGraph(strict.data.taskGraph) : undefined,
      }
      return artifact
    }

    if (options.strictFilesOnly) {
      throw new Error(`MALFORMED_GENERATED_ARTIFACT:${formatArtifactIssues(strict.error.issues)}`)
    }

    const taskGraphOnly = z.object({
      taskGraph: taskGraphSchema,
      framework: z.string().trim().min(1).optional(),
      dependencies: z.array(dependencySchema).optional().default([]),
      commands: z.array(runtimeCommandSchema).optional().default([]),
      summary: z.string().optional().default(""),
      diagnostics: z.array(z.string()).optional().default([]),
      metadata: artifactMetadataSchema.optional().default({}),
    }).strict().superRefine((artifact, ctx) => {
      if (artifact.commands.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "runtime commands are metadata only and are not accepted as executable artifacts",
          path: ["commands"],
        })
      }
    }).safeParse(parsedJson)

    if (taskGraphOnly.success) {
      const taskGraph = toGeneratedTaskGraph(taskGraphOnly.data.taskGraph)
      return {
        files: taskGraph.operations
          .filter((operation) => operation.action !== "delete" && typeof operation.content === "string")
          .map((operation) => ({
            path: operation.path,
            content: operation.content || "",
            language: operation.language || normalizeFileLanguage(undefined),
          })),
        dependencies: [...taskGraphOnly.data.dependencies, ...taskGraph.dependencies],
        commands: [],
        summary: taskGraphOnly.data.summary,
        diagnostics: taskGraphOnly.data.diagnostics,
        metadata: normalizeArtifactMetadata(taskGraphOnly.data.metadata, taskGraphOnly.data.framework),
        repairs: [],
        taskGraph,
      }
    }

    throw new Error(`MALFORMED_GENERATED_ARTIFACT:${formatArtifactIssues(strict.error.issues)}`)
  }

  throw new Error(`MALFORMED_GENERATED_ARTIFACT:${diagnoseJsonEnvelope(providerMessage)}`)
}

function normalizeArtifactMetadata(metadata: Record<string, unknown>, framework?: string): Record<string, unknown> {
  return {
    ...metadata,
    ...(framework ? { framework } : {}),
  }
}

function toGeneratedFile(file: z.infer<typeof generatedFileSchema>): GeneratedFile {
  return {
    path: validateGeneratedPath(file.path).path,
    content: file.content,
    language: normalizeFileLanguage(file.language),
  }
}

function toGeneratedTaskGraph(graph: z.infer<typeof taskGraphSchema>): GeneratedTaskGraph {
  return {
    intent: graph.intent,
    summary: graph.summary,
    dependencies: graph.dependencies,
    operations: graph.operations.map((operation) => ({
      id: operation.id,
      action: operation.action,
      path: validateGeneratedPath(operation.path).path,
      content: operation.content,
      changes: operation.changes,
      language: operation.language ? normalizeFileLanguage(operation.language) : undefined,
      reason: operation.reason,
    })),
  }
}

function assertRequiredFiles(paths: string[], requiredFiles?: string[]) {
  const required = Array.from(new Set((requiredFiles || []).map(normalizeGeneratedPath).filter(Boolean)))
  if (required.length === 0) return

  const present = new Set(paths.map(normalizeGeneratedPath))
  const missing = required.filter((path) => !present.has(path))
  if (missing.length > 0) {
    throw new Error(`MALFORMED_GENERATED_ARTIFACT:${missing.map((path) => `Missing required file: ${path}`).join("; ")}`)
  }
}

function formatArtifactIssues(issues: z.ZodIssue[]) {
  if (issues.length === 0) return "Unsupported artifact structure"
  return issues.map((issue) => {
    const path = issue.path.join(".") || "artifact"
    if (issue.message.includes("Duplicate file path")) return issue.message
    if (path.match(/^files\.\d+\.content$/)) return "File content missing"
    if (path === "files" && issue.message.includes("requires filesystem writes")) return "Empty files array"
    if (issue.message.includes("Required")) return `${path}: missing required value`
    if (issue.message.startsWith("{")) return `Invalid file path at ${path}`
    return `${path}: ${issue.message}`
  }).join("; ")
}

function diagnoseJsonEnvelope(value: string) {
  const raw = String(value || "").trim()
  if (!raw) return "Invalid artifact JSON: response is empty"
  if (/^```/m.test(raw)) return "Markdown wrapper detected but no valid JSON object could be recovered"
  if (!raw.startsWith("{")) return "Invalid artifact JSON: response must start with {"
  return "Invalid artifact JSON"
}

function tryParseJson(value: string, options: { strictEnvelope?: boolean; recoverJson?: boolean } = {}) {
  const raw = String(value || "").trim()
  if (options.strictEnvelope && !isStrictJsonObjectEnvelope(raw)) {
    if (!options.recoverJson) return null
  } else {
    const exact = parseJsonCandidate(raw)
    if (exact) return exact
  }

  if (!options.recoverJson) return null
  const extracted = extractLargestJsonObject(raw)
  if (!extracted) return null
  return parseJsonCandidate(repairJsonCandidate(extracted))
}

function parseJsonCandidate(raw: string) {
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced ? fenced[1].trim() : raw

  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function isStrictJsonObjectEnvelope(raw: string) {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return false
  if (/```/.test(raw)) return false
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

function extractLargestJsonObject(raw: string) {
  let best = ""
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = inString
        continue
      }
      if (char === "\"") {
        inString = !inString
        continue
      }
      if (inString) continue
      if (char === "{") depth += 1
      if (char === "}") depth -= 1
      if (depth === 0) {
        const candidate = raw.slice(start, index + 1)
        if (candidate.length > best.length) best = candidate
        break
      }
    }
  }
  return best || null
}

function repairJsonCandidate(raw: string) {
  let repaired = raw.trim().replace(/,\s*([}\]])/g, "$1")
  let braces = 0
  let brackets = 0
  let inString = false
  let escaped = false
  for (const char of repaired) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = inString
      continue
    }
    if (char === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") braces += 1
    if (char === "}") braces -= 1
    if (char === "[") brackets += 1
    if (char === "]") brackets -= 1
  }
  if (inString) repaired += "\""
  while (brackets > 0) {
    repaired += "]"
    brackets -= 1
  }
  while (braces > 0) {
    repaired += "}"
    braces -= 1
  }
  return repaired
}
