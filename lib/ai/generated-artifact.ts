import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { normalizeGeneratedPath, validateGeneratedPath } from "@/lib/ai/file-policy"
import { normalizeFileLanguage } from "@/lib/workspace-state"

const MAX_GENERATED_FILES = 100
const MAX_SINGLE_FILE_BYTES = 200 * 1024
const PROTECTED_DELETE_FILES = new Set([
  "app/layout.tsx",
  "app/page.tsx",
])

const generatedFileSchema = z.object({
  path: z.string().trim().min(1).refine((path) => {
    try {
      validateGeneratedPath(path)
      return true
    } catch {
      return false
    }
  }, "unsafe generated file path"),
  content: z.string().refine(
    (content) => Buffer.byteLength(content, "utf8") <= MAX_SINGLE_FILE_BYTES,
    "generated file exceeds single-file size limit"
  ),
  language: z.string().trim().optional(),
})

const taskGraphOperationSchema = z.object({
  id: z.string().trim().min(1).optional(),
  action: z.enum(["create", "modify", "delete"]),
  path: z.string().trim().min(1).refine((path) => {
    try {
      validateGeneratedPath(path)
      return true
    } catch {
      return false
    }
  }, "unsafe generated file path"),
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
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  operations: z.array(taskGraphOperationSchema).min(1).max(MAX_GENERATED_FILES),
}).strict()

const generatedArtifactSchema = z.object({
  files: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).default([]),
  dependencies: z.array(z.string().trim().min(1)).optional().default([]),
  commands: z.array(z.never()).optional().default([]),
  summary: z.string().optional().default(""),
  diagnostics: z.array(z.string()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  repairs: z.array(generatedFileSchema).max(MAX_GENERATED_FILES).optional().default([]),
  taskGraph: taskGraphSchema.optional(),
}).strict().superRefine((artifact, ctx) => {
  if (artifact.files.length === 0 && !artifact.taskGraph) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "artifact requires files or taskGraph.operations",
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
        metadata: strict.data.metadata,
        repairs: strict.data.repairs.map(toGeneratedFile),
        taskGraph: strict.data.taskGraph ? toGeneratedTaskGraph(strict.data.taskGraph) : undefined,
      }
    }

    const taskGraphOnly = z.object({
      taskGraph: taskGraphSchema,
      dependencies: z.array(z.string().trim().min(1)).optional().default([]),
      commands: z.array(z.never()).optional().default([]),
      summary: z.string().optional().default(""),
      diagnostics: z.array(z.string()).optional().default([]),
      metadata: z.record(z.unknown()).optional().default({}),
    }).strict().safeParse(parsedJson)

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
        metadata: taskGraphOnly.data.metadata,
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
