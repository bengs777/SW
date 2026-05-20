import { parse } from "@babel/parser"
import type { GeneratedFile } from "@/lib/types"
import { buildDependencyMap } from "@/lib/ai/generation-pipeline"

export type RuntimeSyntaxDiagnostic = {
  file: string
  line: number | null
  column: number | null
  message: string
  repairStrategy?: "auto_fragment_wrap" | "targeted_syntax_repair"
}

export type RuntimeValidationResult = {
  ok: boolean
  diagnostics: RuntimeSyntaxDiagnostic[]
}

const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/i

export function validateRuntimeSyntax(files: GeneratedFile[]): RuntimeValidationResult {
  const diagnostics: RuntimeSyntaxDiagnostic[] = []

  for (const file of files) {
    const path = normalizePath(file.path)
    if (!CODE_FILE_RE.test(path)) continue

    try {
      parse(String(file.content || ""), {
        sourceType: "module",
        errorRecovery: false,
        plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
      })
      const exportDiagnostic = validateExportSafety(path, String(file.content || ""))
      if (exportDiagnostic) diagnostics.push(exportDiagnostic)
      const hookDiagnostic = validateHookSafety(path, String(file.content || ""))
      if (hookDiagnostic) diagnostics.push(hookDiagnostic)
    } catch (error) {
      diagnostics.push(toSyntaxDiagnostic(path, error))
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  }
}

export function autoRepairAdjacentJsxFragments(
  files: GeneratedFile[],
  diagnostic: RuntimeSyntaxDiagnostic | null | undefined
): { repaired: boolean; files: GeneratedFile[]; changedFiles: GeneratedFile[]; strategy: "auto_fragment_wrap" | null } {
  if (!diagnostic || !/adjacent jsx elements/i.test(diagnostic.message)) {
    return { repaired: false, files, changedFiles: [], strategy: null }
  }

  const targetPath = normalizePath(diagnostic.file)
  const target = files.find((file) => normalizePath(file.path) === targetPath)
  if (!target) return { repaired: false, files, changedFiles: [], strategy: null }

  const content = String(target.content || "")
  const repairedContent = wrapReturnBodyInFragment(content)
  if (!repairedContent || repairedContent === content) {
    return { repaired: false, files, changedFiles: [], strategy: null }
  }

  const changed = { ...target, path: targetPath, content: repairedContent }
  return {
    repaired: true,
    files: files.map((file) => normalizePath(file.path) === targetPath ? changed : file),
    changedFiles: [changed],
    strategy: "auto_fragment_wrap",
  }
}

export function validateRuntimeImports(files: GeneratedFile[]): RuntimeValidationResult {
  const diagnostics: RuntimeSyntaxDiagnostic[] = []
  const dependencyMap = buildDependencyMap(files)

  for (const missing of dependencyMap.missingLocalImports) {
    diagnostics.push({
      file: missing.file,
      line: null,
      column: null,
      message: `Missing local import: ${missing.specifier}`,
    })
  }

  for (const unsupported of dependencyMap.unsupportedPreviewImports) {
    diagnostics.push({
      file: unsupported.file,
      line: null,
      column: null,
      message: `Unsupported preview import: ${unsupported.specifier} (${unsupported.reason})`,
    })
  }

  for (const file of files) {
    const path = normalizePath(file.path)
    if (!CODE_FILE_RE.test(path)) continue
    for (const duplicate of duplicateImportSpecifiers(String(file.content || ""))) {
      diagnostics.push({
        file: path,
        line: duplicate.line,
        column: duplicate.column,
        message: `Duplicate import: ${duplicate.specifier}`,
      })
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
  }
}

function toSyntaxDiagnostic(file: string, error: unknown): RuntimeSyntaxDiagnostic {
  const loc = typeof error === "object" && error && "loc" in error
    ? (error as { loc?: { line?: number; column?: number } }).loc
    : null
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = humanizeSyntaxMessage(rawMessage)

  return {
    file,
    line: loc?.line ?? null,
    column: loc?.column ?? null,
    message,
    repairStrategy: /adjacent jsx elements/i.test(rawMessage) ? "auto_fragment_wrap" : "targeted_syntax_repair",
  }
}

function humanizeSyntaxMessage(message: string) {
  if (/adjacent jsx elements/i.test(message)) return "Adjacent JSX elements must be wrapped in a fragment."
  if (/unterminated jsx|missing closing tag/i.test(message)) return "Missing closing tag or unterminated JSX."
  if (/import/i.test(message)) return "Invalid import syntax."
  if (/duplicate export/i.test(message)) return "Duplicate export."
  if (/unexpected token/i.test(message)) return "Unexpected token."
  return message.replace(/\s+\(\d+:\d+\)$/, "").trim()
}

function validateHookSafety(file: string, content: string): RuntimeSyntaxDiagnostic | null {
  const conditionalHook = /\b(if|for|while|switch)\s*\([^)]*\)[\s\S]{0,500}?\buse[A-Z][A-Za-z0-9_]*\s*\(/m.exec(content)
  if (!conditionalHook) return null
  const loc = offsetToLocation(content, conditionalHook.index)
  return {
    file,
    line: loc.line,
    column: loc.column,
    message: "Invalid hook usage: hooks cannot be called conditionally.",
    repairStrategy: "targeted_syntax_repair",
  }
}

function validateExportSafety(file: string, content: string): RuntimeSyntaxDiagnostic | null {
  const defaultExports = Array.from(content.matchAll(/\bexport\s+default\b/g))
  if (defaultExports.length <= 1) return null
  const loc = offsetToLocation(content, defaultExports[1].index || 0)
  return {
    file,
    line: loc.line,
    column: loc.column,
    message: "Duplicate export.",
    repairStrategy: "targeted_syntax_repair",
  }
}

function wrapReturnBodyInFragment(content: string) {
  const returnMatch = content.match(/return\s*\(/)
  if (!returnMatch || typeof returnMatch.index !== "number") return null
  const openParen = content.indexOf("(", returnMatch.index)
  if (openParen < 0) return null
  const closeParen = findMatchingParen(content, openParen)
  if (closeParen < 0) return null
  const body = content.slice(openParen + 1, closeParen)
  if (/<>\s*[\s\S]*<\/>/m.test(body)) return null
  if ((body.match(/<([A-Za-z][\w.]*)\b/g) || []).length < 2) return null
  const leading = body.match(/^\s*/)?.[0] || "\n"
  const trailing = body.match(/\s*$/)?.[0] || "\n"
  const inner = body.trim()
  return `${content.slice(0, openParen + 1)}${leading}<>\n${indentBlock(inner, "  ")}\n${leading}</>${trailing}${content.slice(closeParen)}`
}

function findMatchingParen(content: string, openIndex: number) {
  let depth = 0
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index]
    if (char === "(") depth += 1
    if (char === ")") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function indentBlock(value: string, prefix: string) {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n")
}

function duplicateImportSpecifiers(content: string) {
  const seen = new Map<string, { line: number; column: number }>()
  const duplicates: Array<{ specifier: string; line: number; column: number }> = []
  const importRe = /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g
  for (const match of content.matchAll(importRe)) {
    const specifier = match[1]
    const loc = offsetToLocation(content, match.index || 0)
    if (seen.has(specifier)) {
      duplicates.push({ specifier, ...loc })
    } else {
      seen.set(specifier, loc)
    }
  }
  return duplicates
}

function offsetToLocation(content: string, offset: number) {
  const head = content.slice(0, offset)
  const lines = head.split(/\r?\n/)
  return {
    line: lines.length,
    column: lines[lines.length - 1].length,
  }
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}
