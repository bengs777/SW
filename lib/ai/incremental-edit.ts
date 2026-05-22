import { parse } from "@babel/parser"
import { z } from "zod"
import type { GeneratedFile } from "@/lib/types"
import { buildDependencyMap } from "@/lib/ai/generation-pipeline"
import {
  applySemanticScopedEdit,
  buildSemanticEditDiagnostics,
  type SemanticEditDiagnostics,
  type SemanticEditOperation,
} from "@/lib/ai/semantic-edit"

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
  patchPlan?: TextReplacementOperation
  semanticOperation?: SemanticEditOperation | null
  semanticDiagnostics?: SemanticEditDiagnostics
  reason: string
}

export type TextReplacementOperation = {
  operation: "replace_text"
  targetFile: string
  find: string
  replace: string
  container: string | null
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

export const TextReplacementOperationSchema = z.object({
  operation: z.literal("replace_text"),
  targetFile: z.string().trim().min(1),
  find: z.string(),
  replace: z.string().trim().min(1),
  container: z.string().nullable(),
}).strict().superRefine((operation, ctx) => {
  if (!operation.find.trim() && !operation.container) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["find"],
      message: "Missing replace target",
    })
  }
})

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
  patchPlan: TextReplacementOperationSchema.optional(),
  semanticOperation: z.unknown().optional(),
  semanticDiagnostics: z.unknown().optional(),
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
  if (input.existingFiles.length > 0) return "EDIT"
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

  const semanticPatch = applySemanticScopedEdit({
    prompt: input.prompt,
    files: input.files,
    affectedFiles: input.plan.affectedFiles,
  })
  if (semanticPatch.applied) {
    return {
      applied: true,
      files: semanticPatch.files,
      changedFiles: semanticPatch.changedFiles,
      patchSummary: semanticPatch.patchSummary,
      semanticOperation: semanticPatch.operation,
      semanticDiagnostics: semanticPatch.diagnostics,
      reason: semanticPatch.reason,
    }
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
    patchPlan: input.patch.patchPlan,
    semanticOperation: input.patch.semanticOperation || null,
    semanticDiagnostics: input.patch.semanticDiagnostics || buildSemanticEditDiagnostics({
      files: input.patch.files,
      changedFiles: input.patch.changedFiles,
      operation: input.patch.semanticOperation || null,
      reason: input.patch.reason,
    }),
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
  const grammar = parseReplacementGrammar(input.prompt)
  if (!grammar.ok) return unchanged(input.files, grammar.reason)
  const candidates = candidateFilesForTextUpdate(input.files, input.plan.affectedFiles)

  for (const file of candidates) {
    const resolved = resolveJsxTextReplacement({
      file,
      find: grammar.find,
      replace: grammar.replace,
      targetKind: grammar.targetKind,
    })
    if (!resolved.ok) continue
    const operation = TextReplacementOperationSchema.safeParse({
      operation: "replace_text",
      targetFile: normalizePath(file.path),
      find: resolved.find,
      replace: grammar.replace,
      container: resolved.container,
    })
    if (!operation.success) {
      return unchanged(input.files, humanizeZodIssues(operation.error.issues))
    }
    return replaceFile(
      input.files,
      { ...file, content: resolved.content },
      [`replace_text ${normalizePath(file.path)}: "${resolved.find}" -> "${grammar.replace}"`],
      "Applied deterministic JSX text replacement.",
      operation.data
    )
  }

  if (grammar.find) {
    return unchanged(input.files, `No matching JSX text node found for "${grammar.find}".`)
  }
  return unchanged(input.files, `No ${grammar.targetKind || "heading"} JSX text node found for replacement.`)
}

function insertButton(input: { prompt: string; files: GeneratedFile[]; plan: IncrementalEditPlan }, label: string) {
  const targetPath = input.plan.affectedFiles[0]
  const file = input.files.find((item) => normalizePath(item.path) === targetPath)
  if (!file) return unchanged(input.files, "No affected file found for button patch.")
  const content = String(file.content || "")
  if (new RegExp(`>${escapeRegExp(label)}<`, "i").test(content)) return unchanged(input.files, "Button already appears to exist.")
  const button = `\n        <button type="button" className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800">${label}</button>`
  const insertionPoint = findFirstJsxChildrenInsertionPoint(content)
  const nextContent = insertionPoint === null ? content : `${content.slice(0, insertionPoint)}${button}${content.slice(insertionPoint)}`
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
  const insertionPoint = findFirstJsxChildrenInsertionPoint(content)
  const nextContent = insertionPoint === null ? content : `${content.slice(0, insertionPoint)}\n      ${nav}${content.slice(insertionPoint)}`
  if (nextContent === content) return unchanged(input.files, "No safe JSX insertion point found.")
  return replaceFile(input.files, { ...file, content: nextContent }, [`inserted navbar in ${targetPath}`], "Applied deterministic navbar patch.")
}

function findFirstJsxChildrenInsertionPoint(content: string) {
  const ast = parseTsxAst(content)
  let insertionPoint: number | null = null
  walkAst(ast, [], (node) => {
    if (insertionPoint !== null || node.type !== "JSXElement") return
    const opening = node.openingElement as AstNode | undefined
    if (typeof opening?.end === "number") {
      insertionPoint = opening.end
    }
  })
  return insertionPoint
}

function parseTsxAst(content: string) {
  return parse(String(content || ""), {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
  }) as unknown as AstNode
}

type ReplacementGrammar =
  | { ok: true; find: string | null; replace: string; targetKind: "title" | "heading" | null; normalizedPrompt: string }
  | { ok: false; reason: string }

function parseReplacementGrammar(prompt: string): ReplacementGrammar {
  const raw = String(prompt || "").trim()
  if (!raw) return { ok: false, reason: "Unsupported edit grammar: prompt is empty." }
  const normalized = normalizeReplacementPrompt(raw)
  const quoted = [
    /\b(?:ganti|ubah)\s+"([^"]+)"\s+(?:menjadi|jadi)\s+"([^"]+)"/i,
    /\breplace\s+"([^"]+)"\s+with\s+"([^"]+)"/i,
  ]
  for (const pattern of quoted) {
    const match = normalized.match(pattern)
    if (match?.[1] && match?.[2]) {
      return {
        ok: true,
        find: match[1].trim(),
        replace: match[2].trim(),
        targetKind: null,
        normalizedPrompt: `replace text "${match[1].trim()}" with "${match[2].trim()}"`,
      }
    }
  }

  const heading = normalized.match(/\b(?:ganti|ubah)\s+(judul|heading|title|headline)\s+(?:menjadi|jadi)\s+"?([^"\n]+)"?/i)
  if (heading?.[2]) {
    return {
      ok: true,
      find: null,
      replace: heading[2].trim(),
      targetKind: heading[1].toLowerCase() === "judul" || heading[1].toLowerCase() === "title" ? "title" : "heading",
      normalizedPrompt: `replace ${heading[1].toLowerCase()} with "${heading[2].trim()}"`,
    }
  }

  const unquotedReplace = normalized.match(/\breplace\s+text\s+"([^"]+)"\s+with\s+"([^"]+)"/i)
  if (unquotedReplace?.[1] && unquotedReplace?.[2]) {
    return {
      ok: true,
      find: unquotedReplace[1].trim(),
      replace: unquotedReplace[2].trim(),
      targetKind: null,
      normalizedPrompt: normalized,
    }
  }

  if (/\b(?:ganti|ubah|replace)\b/i.test(normalized)) {
    return { ok: false, reason: "Ambiguous replacement instruction: use ganti \"OLD_TEXT\" menjadi \"NEW_TEXT\" or ganti judul jadi \"NEW_TITLE\"." }
  }

  return { ok: false, reason: "Unsupported edit grammar for text_update." }
}

function normalizeReplacementPrompt(prompt: string) {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length >= 3 && /^(ganti|ubah)\s+jadi$/i.test(lines[1])) {
    return `replace text "${lines[0]}" with "${lines.slice(2).join(" ")}"`
  }
  if (lines.length >= 3 && /^replace\s+with$/i.test(lines[1])) {
    return `replace text "${lines[0]}" with "${lines.slice(2).join(" ")}"`
  }
  return prompt.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim()
}

function candidateFilesForTextUpdate(files: GeneratedFile[], affectedFiles: string[]) {
  const affected = new Set(affectedFiles.map(normalizePath))
  const affectedMatches = files.filter((file) => affected.has(normalizePath(file.path)) && /\.(tsx?|jsx?)$/i.test(file.path))
  if (affectedMatches.length > 0) return affectedMatches
  return files
    .filter((file) => (/^app\/(?:.+\/)?page\.tsx$/i.test(normalizePath(file.path)) || /^components\/.+\.tsx$/i.test(normalizePath(file.path))) && /\.(tsx?|jsx?)$/i.test(file.path))
    .slice(0, 8)
}

function resolveJsxTextReplacement(input: {
  file: GeneratedFile
  find: string | null
  replace: string
  targetKind: "title" | "heading" | null
}): { ok: true; content: string; find: string; container: string | null } | { ok: false; reason: string } {
  const content = String(input.file.content || "")
  const ast = parseTsxAst(content)
  const anchors = collectJsxTextAnchors(ast, content)
  const target = input.find
    ? anchors.find((anchor) => normalizeJsxText(anchor.text) === normalizeJsxText(input.find || ""))
    : anchors.find((anchor) => {
        if (input.targetKind === "title") return anchor.container === "h1" || anchor.container === "title"
        if (input.targetKind === "heading") return /^h[1-6]$/.test(anchor.container || "")
        return false
      })

  if (!target) {
    return { ok: false, reason: input.find ? "No matching JSX text node found" : "No target JSX heading found" }
  }

  const raw = content.slice(target.start, target.end)
  const leading = raw.match(/^\s*/)?.[0] || ""
  const trailing = raw.match(/\s*$/)?.[0] || ""
  const replacement = `${leading}${escapeJsxText(input.replace)}${trailing}`
  return {
    ok: true,
    content: `${content.slice(0, target.start)}${replacement}${content.slice(target.end)}`,
    find: normalizeJsxText(target.text),
    container: target.container,
  }
}

type JsxTextAnchor = {
  text: string
  start: number
  end: number
  container: string | null
}

function collectJsxTextAnchors(ast: AstNode, content: string) {
  const anchors: JsxTextAnchor[] = []
  walkAst(ast, [], (node, parents) => {
    if (node.type !== "JSXText") return
    if (typeof node.start !== "number" || typeof node.end !== "number") return
    const text = normalizeJsxText(content.slice(node.start, node.end))
    if (!text) return
    anchors.push({
      text,
      start: node.start,
      end: node.end,
      container: nearestJsxElementName(parents),
    })
  })
  return anchors
}

function nearestJsxElementName(parents: AstNode[]) {
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index]
    if (parent.type !== "JSXElement") continue
    const opening = parent.openingElement as AstNode | undefined
    const name = opening?.name as AstNode | undefined
    if (name?.type === "JSXIdentifier" && typeof name.name === "string") return name.name
  }
  return null
}

type AstNode = Record<string, unknown> & {
  type?: string
  start?: number
  end?: number
  openingElement?: unknown
  name?: unknown
}

function walkAst(node: unknown, parents: AstNode[], visit: (node: AstNode, parents: AstNode[]) => void) {
  if (!node || typeof node !== "object") return
  const current = node as AstNode
  if (typeof current.type === "string") visit(current, parents)
  const nextParents = typeof current.type === "string" ? [...parents, current] : parents

  for (const [key, value] of Object.entries(current)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, nextParents, visit)
      continue
    }
    if (value && typeof value === "object") walkAst(value, nextParents, visit)
  }
}

function normalizeJsxText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim()
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

function replaceFile(
  files: GeneratedFile[],
  changed: GeneratedFile,
  patchSummary: string[],
  reason: string,
  patchPlan?: TextReplacementOperation
): IncrementalPatchResult {
  const path = normalizePath(changed.path)
  const next = files.map((file) => normalizePath(file.path) === path ? { ...changed, path } : file)
  return {
    applied: true,
    files: next,
    changedFiles: [{ ...changed, path }],
    patchSummary,
    patchPlan,
    reason,
  }
}

function unchanged(files: GeneratedFile[], reason: string): IncrementalPatchResult {
  return {
    applied: false,
    files,
    changedFiles: [],
    patchSummary: [],
    semanticDiagnostics: buildSemanticEditDiagnostics({
      files,
      changedFiles: [],
      operation: null,
      reason,
    }),
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

function humanizeZodIssues(issues: z.ZodIssue[]) {
  if (issues.some((issue) => issue.message === "Missing replace target")) return "Missing replace target."
  return issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ")
}
