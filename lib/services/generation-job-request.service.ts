import { createHash } from "node:crypto"
import { normalizePreviewContext } from "@/lib/ai/preview-context"

export type GenerationJobRequestHashInput = {
  projectId: string
  prompt: string
  model: string
  provider?: string
  promptLanguage?: "id" | "en"
  collaborationMode?: string
  previewContext?: unknown
  attachments: unknown[]
}

export function stableJson(value: unknown): string {
  if (typeof value === "undefined") {
    return "null"
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
}

export function byteSize(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return 0
  }
}

function objectKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : []
}

export function previewContextAudit(value: unknown) {
  const context = normalizePreviewContext(value)
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  const files = Array.isArray(raw?.files) ? raw.files : []
  const previewFiles = Array.isArray(raw?.previewFiles) ? raw.previewFiles : []
  const diagnostics = raw && Array.isArray(raw.diagnostics) ? raw.diagnostics : []
  const selectedPaths = new Set<string>()

  if (context?.activeFilePath) {
    selectedPaths.add(context.activeFilePath)
  }

  for (const file of [...files, ...previewFiles]) {
    if (file && typeof file === "object" && "isActive" in file && (file as { isActive?: unknown }).isActive) {
      const path = (file as { path?: unknown }).path
      if (typeof path === "string") {
        selectedPaths.add(path)
      }
    }
  }

  return {
    normalized: context,
    hasPreviewContext: Boolean(value),
    keys: objectKeys(value),
    activeFile: context?.activeFilePath || null,
    diagnosticsCount: diagnostics.length,
    filesCount: files.length,
    previewFilesCount: previewFiles.length,
    selectedPathsCount: selectedPaths.size,
    sizeBytes: byteSize(value ?? null),
  }
}

export function generationRequestHash(input: GenerationJobRequestHashInput) {
  const now = new Date()
  const dedupeBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`
  const payload = {
    dedupeBucket,
    projectId: input.projectId,
    prompt: input.prompt.replace(/\s+/g, " ").trim(),
    model: input.model,
    provider: input.provider || "swift",
    promptLanguage: input.promptLanguage,
    collaborationMode: input.collaborationMode || "",
    previewContext: createHash("sha256").update(stableJson(input.previewContext || null)).digest("hex"),
    attachments: input.attachments.map((attachment) =>
      createHash("sha256").update(stableJson(attachment)).digest("hex")
    ),
  }

  return createHash("sha256").update(stableJson(payload)).digest("hex")
}
