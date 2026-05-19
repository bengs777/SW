import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { formatGeneratedPathValidationError, normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
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
  action: z.enum(["create", "modify", "delete"]),
  path: generatedPathSchema,
  content: z.string().optional(),
  language: z.string().trim().optional(),
  reason: z.string().optional(),
}).strict().superRefine((operation, ctx) => {
  const path = normalizeGeneratedPath(operation.path)

  if ((operation.action === "create" || operation.action === "modify") && typeof operation.content !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "create/modify operation requires full content",
      path: ["content"],
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
  operations: z.array(taskGraphOperationSchema).min(1).max(MAX_GENERATED_FILES),
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
  action: "create" | "modify" | "delete"
  path: string
  content?: string
  language?: GeneratedFile["language"]
  reason?: string
}

export function parseGeneratedArtifact(providerMessage: string): GeneratedArtifact {
  const parsedJson = tryParseJson(providerMessage)
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const strict = generatedArtifactSchema.safeParse(parsedJson)
    if (strict.success) {
      return {
        files: strict.data.files.map(toGeneratedFile),
        dependencies: strict.data.dependencies,
        commands: [],
        summary: strict.data.summary,
        diagnostics: strict.data.diagnostics,
        metadata: normalizeArtifactMetadata(strict.data.metadata, strict.data.framework),
        repairs: strict.data.repairs.map(toGeneratedFile),
        taskGraph: strict.data.taskGraph ? toGeneratedTaskGraph(strict.data.taskGraph) : undefined,
      }
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

    const detail = strict.error.issues
      .map((issue) => `${issue.path.join(".") || "artifact"}: ${issue.message}`)
      .join("; ")
    throw new Error(`MALFORMED_GENERATED_ARTIFACT:schema:${detail}`)
  }

  throw new Error("MALFORMED_GENERATED_ARTIFACT:strict-json-schema-required")
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
      language: operation.language ? normalizeFileLanguage(operation.language) : undefined,
      reason: operation.reason,
    })),
  }
}

function tryParseJson(value: string) {
  const raw = String(value || "").trim()

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
