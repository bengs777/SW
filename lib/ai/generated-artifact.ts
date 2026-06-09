import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import {
  ALLOWED_GENERATED_ROOTS,
  SAFE_GENERATED_ROOT_FILES,
  formatGeneratedPathValidationError,
  normalizeGeneratedPath,
  validateGeneratedPath,
  type GeneratedPathValidationDiagnostic,
} from "@/lib/ai/file-policy"
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
  action: z.enum(["createFile", "modifyFile", "deleteFile", "patchFile", "create", "modify", "delete", "patch"]).optional(),
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

export type GeneratedArtifactEnvelopeAudit = {
  rawLength: number
  startsWithObject: boolean
  strictEnvelope: boolean
  bracketBalanced: boolean
  objectClosed: boolean
  truncated: boolean
  recovered: boolean
  schemaValid: boolean
  hasTaskGraph: boolean
  taskGraphOperationCount: number
  issues: string[]
}

export type GeneratedArtifactContractErrorCode =
  | "MALFORMED_GENERATED_ARTIFACT"
  | "PATH_ERROR"
  | "UNKNOWN_ARTIFACT_ERROR"

export type GeneratedArtifactContractCategory =
  | "json_envelope"
  | "path_policy"
  | "schema"
  | "diagnostic_payload"
  | "runtime_message"
  | "missing_required_file"
  | "empty_files"
  | "unsupported_structure"
  | "unknown"

export type GeneratedArtifactContractDiagnostic = {
  code: GeneratedArtifactContractErrorCode
  category: GeneratedArtifactContractCategory
  reason: string
  rawMessage: string
  path?: string | null
  received?: string | null
  expected?: string | null
  missingFiles: string[]
  allowedRoots: readonly string[]
  allowedRootFiles: readonly string[]
  rawLength?: number
  rawHash?: string
  issueCount: number
  artifactAudit?: Record<string, unknown> | null
  requiredFiles?: string[]
}

export function summarizeArtifactContractError(
  error: unknown,
  input: {
    rawLength?: number
    rawHash?: string
    artifactAudit?: Record<string, unknown> | null
    requiredFiles?: string[]
  } = {}
): GeneratedArtifactContractDiagnostic {
  const rawMessage = error instanceof Error ? error.message : String(error || "")
  const message = rawMessage || "Unknown artifact contract error"
  const pathDiagnostic = parsePathDiagnosticMessage(message)
  const code = pathDiagnostic || /PATH_ERROR|Invalid file path|Root file not allowlisted|Blocked path/i.test(message)
    ? "PATH_ERROR"
    : /^MALFORMED_GENERATED_ARTIFACT/i.test(message) ||
      /Unrecognized key\(s\)|strict-json-schema|required|diagnostic payload|Missing required|Empty files array|Unsupported artifact structure/i.test(message)
      ? "MALFORMED_GENERATED_ARTIFACT"
      : "UNKNOWN_ARTIFACT_ERROR"
  const category = classifyArtifactContractFailure(message, code)
  const missingFiles = extractMissingRequiredFiles(message)
  const cleanedReason = compactArtifactErrorReason(message, pathDiagnostic)

  return {
    code,
    category,
    reason: cleanedReason,
    rawMessage: truncateDiagnosticText(message, 1800),
    path: pathDiagnostic?.expected || null,
    received: pathDiagnostic?.received || null,
    expected: pathDiagnostic?.expected || null,
    missingFiles,
    allowedRoots: ALLOWED_GENERATED_ROOTS,
    allowedRootFiles: pathDiagnostic?.allowedRootFiles || SAFE_GENERATED_ROOT_FILES,
    ...(typeof input.rawLength === "number" ? { rawLength: input.rawLength } : {}),
    ...(input.rawHash ? { rawHash: input.rawHash } : {}),
    issueCount: countContractIssues(message),
    artifactAudit: input.artifactAudit || null,
    requiredFiles: input.requiredFiles?.map(normalizeGeneratedPath).filter(Boolean).slice(0, 80),
  }
}

export function buildArtifactContractRepairInstructions(
  diagnostic: GeneratedArtifactContractDiagnostic | null | undefined,
  input: {
    target?: string
    requiredFiles?: string[]
    allowedPaths?: string[]
    maxChangedFiles?: number
    outputMode?: "files" | "taskGraph"
  } = {}
) {
  const requiredFiles = Array.from(new Set((input.requiredFiles || diagnostic?.requiredFiles || []).map(normalizeGeneratedPath).filter(Boolean)))
  const allowedPaths = Array.from(new Set((input.allowedPaths || []).map(normalizeGeneratedPath).filter(Boolean))).slice(0, 120)
  const outputMode = input.outputMode || "files"
  const lines = [
    "ARTIFACT_CONTRACT_REPAIR:",
    `- Previous artifact error code: ${diagnostic?.code || "UNKNOWN_ARTIFACT_ERROR"}.`,
    `- Previous artifact error category: ${diagnostic?.category || "unknown"}.`,
    `- Previous artifact failure reason: ${diagnostic?.reason || "Unknown artifact contract failure"}.`,
    "- Return ONLY strict JSON. No Markdown fences, no prose, no comments.",
    outputMode === "taskGraph"
      ? '- Return a taskGraph envelope: {"taskGraph":{"operations":[{"operation":"modifyFile","file":"app/page.tsx","content":"full file content"}]},"dependencies":[],"commands":[],"summary":"","diagnostics":[],"metadata":{}}.'
      : '- BUILD output must use {"files":[{"path":"app/page.tsx","language":"tsx","content":"full file content"}],"dependencies":[],"commands":[],"summary":"","diagnostics":[],"metadata":{},"repairs":[]}.',
    outputMode === "taskGraph"
      ? "- taskGraph.operations must be non-empty and every listed target file must appear as createFile or modifyFile."
      : "- taskGraph is not allowed when strict files-only output is requested.",
    `- Allowed generated roots: ${ALLOWED_GENERATED_ROOTS.join(", ")}.`,
    `- Allowed root files: ${SAFE_GENERATED_ROOT_FILES.join(", ")}.`,
    "- Never write .env, .env.production, .git, node_modules, package-lock.json, pnpm-lock.yaml, yarn.lock, absolute paths, or traversal paths.",
  ]

  if (diagnostic?.received) {
    lines.push(`- Fix rejected path: ${diagnostic.received}.`)
  }
  if (diagnostic?.missingFiles.length) {
    lines.push(`- Include missing files: ${diagnostic.missingFiles.join(", ")}.`)
  }
  if (requiredFiles.length > 0) {
    lines.push(`- Required files for this slice: ${requiredFiles.join(", ")}.`)
  }
  if (allowedPaths.length > 0) {
    lines.push(`- Approved file scope: ${allowedPaths.join(", ")}.`)
  }
  if (typeof input.maxChangedFiles === "number") {
    lines.push(`- Do not return more than ${input.maxChangedFiles} changed files.`)
  }
  if (input.target) {
    lines.push(`- Cover exactly this slice target: ${input.target}.`)
  }

  return lines.join("\n")
}

export function auditGeneratedArtifactEnvelope(providerMessage: string): GeneratedArtifactEnvelopeAudit {
  const raw = String(providerMessage || "").trim()
  const balance = inspectJsonBalance(raw)
  const exact = parseJsonCandidate(raw)
  const extracted = exact ? null : extractLargestJsonObject(raw)
  const partial = exact || extracted ? null : extractJsonFromFirstObject(raw)
  const recovered = exact
    ? null
    : extracted
      ? parseJsonCandidate(repairJsonCandidate(extracted))
      : parseJsonCandidate(repairJsonCandidate(partial || ""))
  const parsed = exact || recovered
  const schema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? generatedArtifactSchema.safeParse(parsed)
    : null
  const taskGraphOnly = !schema?.success && parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? z.object({
        taskGraph: taskGraphSchema,
        framework: z.string().trim().min(1).optional(),
        dependencies: z.array(dependencySchema).optional().default([]),
        commands: z.array(runtimeCommandSchema).optional().default([]),
        summary: z.string().optional().default(""),
        diagnostics: z.array(z.string()).optional().default([]),
        metadata: artifactMetadataSchema.optional().default({}),
      }).strict().safeParse(parsed)
    : null
  const hasTaskGraph = Boolean(
    (schema?.success && schema.data.taskGraph?.operations.length) ||
    (taskGraphOnly?.success && taskGraphOnly.data.taskGraph.operations.length)
  )

  return {
    rawLength: raw.length,
    startsWithObject: raw.startsWith("{"),
    strictEnvelope: isStrictJsonObjectEnvelope(raw),
    bracketBalanced: balance.balanced,
    objectClosed: balance.objectClosed,
    truncated: raw.length > 0 && (!balance.objectClosed || balance.inString || balance.brackets > 0),
    recovered: !exact && Boolean(recovered),
    schemaValid: Boolean(schema?.success || taskGraphOnly?.success),
    hasTaskGraph,
    taskGraphOperationCount:
      schema?.success && schema.data.taskGraph
        ? schema.data.taskGraph.operations.length
        : taskGraphOnly?.success
          ? taskGraphOnly.data.taskGraph.operations.length
          : 0,
    issues: schema?.success || taskGraphOnly?.success
      ? []
      : parsed
        ? schema
          ? formatArtifactIssues(schema.error.issues).split("; ")
          : ["Unsupported artifact structure"]
        : [diagnoseJsonEnvelope(providerMessage)],
  }
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
    const pathDiagnostic = parsePathDiagnosticMessage(issue.message)
    if (pathDiagnostic) {
      return `PATH_ERROR at ${path}: ${pathDiagnostic.reason}${pathDiagnostic.received ? ` (received: ${pathDiagnostic.received})` : ""}`
    }
    return `${path}: ${issue.message}`
  }).join("; ")
}

function classifyArtifactContractFailure(
  message: string,
  code: GeneratedArtifactContractErrorCode
): GeneratedArtifactContractCategory {
  if (code === "PATH_ERROR") return "path_policy"
  if (/diagnostic-payload|runtime-message:diagnostic|diagnostic payload/i.test(message)) return "diagnostic_payload"
  if (/runtime-message:/i.test(message)) return "runtime_message"
  if (/Missing required (operation\/file|file)/i.test(message)) return "missing_required_file"
  if (/Empty files array|requires filesystem writes/i.test(message)) return "empty_files"
  if (/Unsupported artifact structure|taskGraph/i.test(message)) return "unsupported_structure"
  if (/Invalid artifact JSON|Markdown wrapper|response must start with \{|response is empty/i.test(message)) return "json_envelope"
  if (/Unrecognized key\(s\)|strict-json-schema|missing required value|required|schema/i.test(message)) return "schema"
  return "unknown"
}

function parsePathDiagnosticMessage(message: string): GeneratedPathValidationDiagnostic | null {
  const jsonMatches = String(message || "").match(/\{[^{}]*"PATH_ERROR"[^{}]*\}/g) || []
  for (const json of jsonMatches) {
    try {
      const parsed = JSON.parse(json) as GeneratedPathValidationDiagnostic
      if (parsed?.error === "PATH_ERROR") return parsed
    } catch {
      // Keep scanning; Zod may wrap several issue messages.
    }
  }

  const formatted = String(message || "").match(/PATH_ERROR at [^:;]+:\s*([^;(]+)(?:\s*\(received:\s*([^)]+)\))?/i)
  if (formatted) {
    return {
      error: "PATH_ERROR",
      reason: formatted[1].trim(),
      received: formatted[2]?.trim() || "",
    }
  }

  return null
}

function compactArtifactErrorReason(message: string, pathDiagnostic: GeneratedPathValidationDiagnostic | null) {
  if (pathDiagnostic) {
    return truncateDiagnosticText(
      `${pathDiagnostic.reason}${pathDiagnostic.received ? `: ${pathDiagnostic.received}` : ""}`,
      600
    )
  }

  return truncateDiagnosticText(
    String(message || "")
      .replace(/^MALFORMED_GENERATED_ARTIFACT:/, "")
      .replace(/^schema:/, "")
      .trim() || "Invalid artifact structure",
    600
  )
}

function extractMissingRequiredFiles(message: string) {
  const missing = new Set<string>()
  const operationMatch = String(message || "").match(/Missing required operation\/file:\s*([^;]+)/i)
  if (operationMatch) {
    for (const item of operationMatch[1].split(",")) {
      const normalized = normalizeGeneratedPath(item.trim())
      if (normalized) missing.add(normalized)
    }
  }

  for (const match of String(message || "").matchAll(/Missing required file:\s*([^;]+)/gi)) {
    const normalized = normalizeGeneratedPath(match[1].trim())
    if (normalized) missing.add(normalized)
  }

  return Array.from(missing).slice(0, 80)
}

function countContractIssues(message: string) {
  const compact = String(message || "").replace(/^MALFORMED_GENERATED_ARTIFACT:/, "")
  return compact.split(";").map((item) => item.trim()).filter(Boolean).length || 1
}

function truncateDiagnosticText(value: string, maxLength: number) {
  const text = String(value || "")
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated:${text.length - maxLength}>` : text
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
  if (extracted) {
    const parsed = parseJsonCandidate(repairJsonCandidate(extracted))
    if (parsed) return parsed
  }
  const partial = extractJsonFromFirstObject(raw)
  if (!partial) return null
  return parseJsonCandidate(repairJsonCandidate(partial))
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

function extractJsonFromFirstObject(raw: string) {
  const start = raw.indexOf("{")
  if (start < 0) return null
  return raw.slice(start).trim()
}

function inspectJsonBalance(raw: string) {
  let braces = 0
  let brackets = 0
  let inString = false
  let escaped = false
  let invalidClose = false
  for (const char of raw) {
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
    if (braces < 0 || brackets < 0) invalidClose = true
  }
  return {
    braces,
    brackets,
    inString,
    objectClosed: braces === 0 && raw.trim().endsWith("}"),
    balanced: braces === 0 && brackets === 0 && !inString && !invalidClose,
  }
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
