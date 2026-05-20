import { parse } from "@babel/parser"
import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { buildDependencyMap } from "@/lib/ai/generation-pipeline"

export type GenerationMode = "BUILD" | "EDIT" | "FIX"

export type IncrementalEditIntent =
  | "text_update"
  | "component_patch"
  | "style_update"
  | "route_update"
  | "api_extension"
  | "db_extension"
  | "auth_extension"

export type IncrementalEditPlan = {
  generationMode: GenerationMode
  editIntent: IncrementalEditIntent | null
  affectedFiles: string[]
  relatedFiles: string[]
  allowedNewFiles: string[]
  reason: string
}

export type IncrementalPatchResult = {
  applied: boolean
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  patchSummary: string[]
  reason: string
}

export type IncrementalValidationResult = {
  ok: boolean
  validationScope: "target_tsx" | "component_subtree" | "css_only" | "route_only" | "prisma_only"
  scope: string[]
  diagnostics: Array<{
    file?: string
    line?: number | null
    column?: number | null
    reason: string
  }>
}

export const PatchOperationSchema = z.object({
  action: z.enum(["create", "modify", "delete"]),
  path: z.string().trim().min(1),
  content: z.string().optional(),
  reason: z.string().optional(),
}).strict().superRefine((operation, ctx) => {
  if ((operation.action === "create" || operation.action === "modify") && typeof operation.content !== "string") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "create/modify patch operations require content",
    })
  }
})

export const RepairPayloadSchema = z.object({
  mode: z.enum(["scoped", "architecture"]),
  affectedFiles: z.array(z.string().trim().min(1)).default([]),
  operations: z.array(PatchOperationSchema).default([]),
}).strict()

export const ScopedEditResultSchema = z.object({
  generationMode: z.enum(["EDIT", "FIX"]),
  editIntent: z.enum([
    "text_update",
    "component_patch",
    "style_update",
    "route_update",
    "api_extension",
    "db_extension",
    "auth_extension",
  ]),
  affectedFiles: z.array(z.string().trim().min(1)),
  patchSummary: z.array(z.string()).default([]),
  validation: z.object({
    ok: z.boolean(),
    diagnostics: z.array(z.object({
      file: z.string().optional(),
      line: z.number().nullable().optional(),
      column: z.number().nullable().optional(),
      reason: z.string(),
    })),
  }),
}).strict()

export type RepairPayload = z.infer<typeof RepairPayloadSchema>
export type ScopedEditResult = z.infer<typeof ScopedEditResultSchema>

export function detectGenerationMode(input: {
  prompt: string
  existingFiles: GeneratedFile[]
  collaborationMode?: string | null
}): GenerationMode {
  const text = normalizeText(input.prompt)
  const mode = String(input.collaborationMode || "").toLowerCase()
  if (mode === "fix" || /\b(fix|repair|perbaiki|error|bug|crash|module not found|cannot find module|import error)\b/i.test(text)) return "FIX"
  if (mode === "edit") return "EDIT"
  if (input.existingFiles.length > 0 && isEditLikePrompt(text)) return "EDIT"
  return "BUILD"
}

export function classifyIncrementalEditIntent(prompt: string): IncrementalEditIntent | null {
  const text = normalizeText(prompt)
  if (/\b(auth|login|register|session|admin login|nextauth|role|rbac)\b/i.test(text)) return "auth_extension"
  if (/\b(database|db|schema|prisma|model|table|migration)\b/i.test(text)) return "db_extension"
  if (/\b(api|endpoint|route handler|webhook)\b/i.test(text)) return "api_extension"
  if (/\b(route|page|halaman|navigation path)\b/i.test(text)) return "route_update"
  if (/\b(color|warna|style|spacing|font|responsive|mobile|dark|light|tema)\b/i.test(text)) return "style_update"
  if (/\b(button|tombol|navbar|nav|menu|card|section|form|modal|table|chart|component|komponen|tambahkan|add)\b/i.test(text)) return "component_patch"
  if (/\b(title|judul|headline|copy|text|teks|label|ganti|ubah|change|rename)\b/i.test(text)) return "text_update"
  return null
}

export function buildIncrementalEditPlan(input: {
  prompt: string
  files: GeneratedFile[]
  collaborationMode?: string | null
  activeFilePath?: string | null
  previewErrorFile?: string | null
}): IncrementalEditPlan {
  const generationMode = detectGenerationMode({
    prompt: input.prompt,
    existingFiles: input.files,
    collaborationMode: input.collaborationMode,
  })
  const editIntent = generationMode === "BUILD" ? null : classifyIncrementalEditIntent(input.prompt) || "component_patch"
  const existingPaths = input.files.map((file) => normalizePath(file.path))
  const affected = new Set<string>()
  const allowedNew = new Set<string>()
  const active = normalizePath(input.activeFilePath || "")
  const errorFile = normalizePath(input.previewErrorFile || "")

  if (active && existingPaths.includes(active)) affected.add(active)
  if (errorFile && existingPaths.includes(errorFile)) affected.add(errorFile)

  if (generationMode === "FIX") {
    addMatching(affected, existingPaths, [/^app\/.+\/page\.tsx$/i, /^app\/page\.tsx$/i, /^components\//i, /^app\/api\//i], 4)
  } else if (editIntent === "text_update" || editIntent === "component_patch" || editIntent === "style_update") {
    addMatching(affected, existingPaths, [/^app\/page\.tsx$/i, /^app\/.+\/page\.tsx$/i, /^components\//i], editIntent === "text_update" ? 1 : 3)
    if (editIntent === "component_patch" && /\b(navbar|nav|menu)\b/i.test(input.prompt)) allowedNew.add("components/navbar.tsx")
  } else if (editIntent === "api_extension") {
    addMatching(affected, existingPaths, [/^app\/api\//i, /^lib\/services\//i], 4)
  } else if (editIntent === "db_extension") {
    addMatching(affected, existingPaths, [/^prisma\/schema\.prisma$/i, /^lib\/services\//i], 4)
  } else if (editIntent === "auth_extension") {
    addMatching(affected, existingPaths, [/auth/i, /^app\/api\/auth\//i, /^lib\//i, /^app\/page\.tsx$/i], 4)
    allowedNew.add("app/api/auth/[...nextauth]/route.ts")
  }

  if (affected.size === 0) {
    const fallback = existingPaths.find((path) => /^app\/page\.tsx$/i.test(path)) || existingPaths.find((path) => /^app\/.+\/page\.tsx$/i.test(path))
    if (fallback) affected.add(fallback)
  }

  const related = findRelatedFiles({
    files: input.files,
    affectedFiles: Array.from(affected),
    intent: editIntent,
  })

  return {
    generationMode,
    editIntent,
    affectedFiles: Array.from(affected),
    relatedFiles: related,
    allowedNewFiles: Array.from(allowedNew),
    reason:
      generationMode === "BUILD"
        ? "Prompt is a new build request."
        : `Prompt classified as ${generationMode} / ${editIntent}; scoped to ${affected.size} file(s).`,
  }
}

export function applyDeterministicIncrementalPatch(input: {
  prompt: string
  files: GeneratedFile[]
  plan: IncrementalEditPlan
}): IncrementalPatchResult {
  if (input.plan.generationMode !== "EDIT") {
    return unchanged(input.files, "Deterministic patch is only used for EDIT mode.")
  }

  if (input.plan.editIntent === "text_update") {
    return applyTextUpdate(input)
  }

  if (input.plan.editIntent === "component_patch") {
    if (/\b(checkout|tombol checkout|checkout button)\b/i.test(input.prompt)) {
      return insertButton(input, "Checkout")
    }
    if (/\b(navbar|nav|menu)\b/i.test(input.prompt)) {
      return insertNavbar(input)
    }
    if (/\b(button|tombol)\b/i.test(input.prompt)) {
      return insertButton(input, extractQuotedValue(input.prompt) || "Action")
    }
  }

  return unchanged(input.files, "No deterministic patch rule matched; provider scoped edit may run.")
}

export function validateIncrementalPatch(input: {
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  plan: IncrementalEditPlan
}): IncrementalValidationResult {
  const scope = unique([...input.plan.affectedFiles, ...input.changedFiles.map((file) => normalizePath(file.path))])
  const validationScope = validationScopeForIntent(input.plan.editIntent)
  const diagnostics: IncrementalValidationResult["diagnostics"] = []

  for (const file of input.changedFiles) {
    const path = normalizePath(file.path)
    if (validationScope === "css_only") {
      const cssDiagnostic = validateCssLikeContent(file)
      if (cssDiagnostic) diagnostics.push(cssDiagnostic)
      continue
    }
    if (validationScope === "prisma_only") {
      const prismaDiagnostic = validatePrismaLikeContent(file)
      if (prismaDiagnostic) diagnostics.push(prismaDiagnostic)
      continue
    }
    if (!/\.(tsx?|jsx?)$/i.test(path)) continue
    try {
      parse(String(file.content || ""), {
        sourceType: "module",
        errorRecovery: false,
        plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
      })
    } catch (error) {
      const loc = typeof error === "object" && error && "loc" in error ? (error as { loc?: { line?: number; column?: number } }).loc : null
      diagnostics.push({
        file: path,
        line: loc?.line ?? null,
        column: loc?.column ?? null,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const dependencyMap = buildDependencyMap(input.files)
  for (const missing of dependencyMap.missingLocalImports) {
    if (!scope.includes(normalizePath(missing.file))) continue
    diagnostics.push({
      file: missing.file,
      reason: `Missing local import after scoped edit: ${missing.specifier}`,
    })
  }

  return {
    ok: diagnostics.length === 0,
    validationScope,
    scope,
    diagnostics,
  }
}

export function parseRepairPayload(value: unknown): { ok: true; payload: RepairPayload } | { ok: false; reason: string } {
  const parsed = RepairPayloadSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; "),
    }
  }
  return { ok: true, payload: parsed.data }
}

export function buildScopedEditResult(input: {
  plan: IncrementalEditPlan
  patch: IncrementalPatchResult
  validation: IncrementalValidationResult
}): ScopedEditResult {
  return ScopedEditResultSchema.parse({
    generationMode: input.plan.generationMode === "FIX" ? "FIX" : "EDIT",
    editIntent: input.plan.editIntent || "component_patch",
    affectedFiles: input.plan.affectedFiles,
    patchSummary: input.patch.patchSummary,
    validation: {
      ok: input.validation.ok,
      diagnostics: input.validation.diagnostics,
    },
  })
}

function applyTextUpdate(input: {
  prompt: string
  files: GeneratedFile[]
  plan: IncrementalEditPlan
}): IncrementalPatchResult {
  const targetText = extractReplacementText(input.prompt)
  if (!targetText) return unchanged(input.files, "No replacement text found in edit prompt.")
  const targetPath = input.plan.affectedFiles[0]
  const file = input.files.find((item) => normalizePath(item.path) === targetPath)
  if (!file) return unchanged(input.files, "No affected file found for text update.")

  const nextContent = replaceLikelyTitle(String(file.content || ""), targetText)
  if (nextContent === file.content) return unchanged(input.files, "No title-like JSX text found to replace.")
  return replaceFile(input.files, { ...file, content: nextContent }, [`updated title text in ${targetPath}`], "Applied deterministic text update.")
}

function insertButton(input: { prompt: string; files: GeneratedFile[]; plan: IncrementalEditPlan }, label: string) {
  const targetPath = input.plan.affectedFiles[0]
  const file = input.files.find((item) => normalizePath(item.path) === targetPath)
  if (!file) return unchanged(input.files, "No affected file found for button patch.")
  const content = String(file.content || "")
  if (new RegExp(`>${escapeRegExp(label)}<`, "i").test(content)) return unchanged(input.files, "Button already appears to exist.")
  const button = `\n        <button type="button" className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800">${label}</button>`
  const nextContent = content.replace(/(<\/(?:section|main|div)>)/, `${button}\n      $1`)
  if (nextContent === content) return unchanged(input.files, "No safe JSX insertion point found.")
  return replaceFile(input.files, { ...file, content: nextContent }, [`inserted ${label} button in ${targetPath}`], "Applied deterministic component patch.")
}

function insertNavbar(input: { files: GeneratedFile[]; plan: IncrementalEditPlan }) {
  const targetPath = input.plan.affectedFiles[0]
  const file = input.files.find((item) => normalizePath(item.path) === targetPath)
  if (!file) return unchanged(input.files, "No affected file found for navbar patch.")
  const content = String(file.content || "")
  if (/<nav\b/i.test(content)) return unchanged(input.files, "Navbar already appears to exist.")
  const nav = `<nav className="mb-6 flex items-center justify-between border-b border-neutral-200 pb-4">
        <span className="text-sm font-semibold">Coffee Shop</span>
        <div className="flex gap-3 text-sm text-neutral-600">
          <a href="#">Menu</a>
          <a href="#">Orders</a>
          <a href="#">Contact</a>
        </div>
      </nav>\n      `
  const nextContent = content.replace(/(<(?:main|section|div)\b[^>]*>)/, `$1\n      ${nav}`)
  if (nextContent === content) return unchanged(input.files, "No safe JSX insertion point found.")
  return replaceFile(input.files, { ...file, content: nextContent }, [`inserted navbar in ${targetPath}`], "Applied deterministic navbar patch.")
}

function replaceLikelyTitle(content: string, replacement: string) {
  ensureTsxAst(content)
  const escaped = escapeJsxText(replacement)
  const headingPattern = /(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i
  if (headingPattern.test(content)) return content.replace(headingPattern, `$1${escaped}$3`)
  const titlePattern = /(<title\b[^>]*>)([\s\S]*?)(<\/title>)/i
  if (titlePattern.test(content)) return content.replace(titlePattern, `$1${escaped}$3`)
  return content
}

function ensureTsxAst(content: string) {
  parse(String(content || ""), {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
  })
}

function validationScopeForIntent(intent: IncrementalEditIntent | null): IncrementalValidationResult["validationScope"] {
  if (intent === "text_update") return "target_tsx"
  if (intent === "component_patch") return "component_subtree"
  if (intent === "style_update") return "css_only"
  if (intent === "api_extension" || intent === "route_update" || intent === "auth_extension") return "route_only"
  if (intent === "db_extension") return "prisma_only"
  return "component_subtree"
}

function validateCssLikeContent(file: GeneratedFile) {
  const content = String(file.content || "")
  const open = (content.match(/\{/g) || []).length
  const close = (content.match(/\}/g) || []).length
  if (open !== close) {
    return {
      file: normalizePath(file.path),
      reason: "CSS brace mismatch in scoped style edit",
    }
  }
  return null
}

function validatePrismaLikeContent(file: GeneratedFile) {
  const content = String(file.content || "")
  if (normalizePath(file.path) === "prisma/schema.prisma" && !/\bmodel\s+[A-Z][A-Za-z0-9_]*\s*\{/.test(content)) {
    return {
      file: normalizePath(file.path),
      reason: "Prisma scoped edit must preserve at least one model block",
    }
  }
  return null
}

function extractReplacementText(prompt: string) {
  const patterns = [
    /\b(?:jadi|menjadi|to)\s+["']?([^"'\n.]+)["']?/i,
    /\b(?:ganti|ubah|change|rename).*?\b(?:judul|title|headline).*?["']([^"']+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = prompt.match(pattern)
    if (match?.[1]) return toTitleCase(match[1].trim())
  }
  return extractQuotedValue(prompt)
}

function extractQuotedValue(prompt: string) {
  const quoted = prompt.match(/["']([^"']+)["']/)
  return quoted?.[1]?.trim() || null
}

function findRelatedFiles(input: {
  files: GeneratedFile[]
  affectedFiles: string[]
  intent: IncrementalEditIntent | null
}) {
  const related = new Set<string>()
  const affected = new Set(input.affectedFiles)
  if (input.intent === "style_update" && input.files.some((file) => normalizePath(file.path) === "app/globals.css")) {
    related.add("app/globals.css")
  }
  for (const file of input.files) {
    const path = normalizePath(file.path)
    const content = String(file.content || "")
    for (const target of affected) {
      const stem = target.split("/").pop()?.replace(/\.(tsx?|jsx?)$/, "") || ""
      if (stem && content.includes(stem) && !affected.has(path)) related.add(path)
    }
  }
  return Array.from(related).slice(0, 4)
}

function addMatching(targets: Set<string>, paths: string[], patterns: RegExp[], limit: number) {
  for (const path of paths) {
    if (patterns.some((pattern) => pattern.test(path))) targets.add(path)
    if (targets.size >= limit) break
  }
}

function replaceFile(files: GeneratedFile[], changed: GeneratedFile, patchSummary: string[], reason: string): IncrementalPatchResult {
  const path = normalizePath(changed.path)
  const next = files.map((file) => normalizePath(file.path) === path ? { ...changed, path } : file)
  return {
    applied: true,
    files: next,
    changedFiles: [{ ...changed, path }],
    patchSummary,
    reason,
  }
}

function unchanged(files: GeneratedFile[], reason: string): IncrementalPatchResult {
  return {
    applied: false,
    files,
    changedFiles: [],
    patchSummary: [],
    reason,
  }
}

function isEditLikePrompt(text: string) {
  return /\b(ganti|ubah|update|edit|rename|change|tambahkan|add|hapus|remove|polish|refine|perbaiki|fix)\b/i.test(text)
}

function normalizeText(value: string) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim()
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeJsxText(value: string) {
  return value.replace(/[<>{}]/g, "")
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ")
}
