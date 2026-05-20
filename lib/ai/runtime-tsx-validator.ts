import { parse } from "@babel/parser"
import generate from "@babel/generator"
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
): {
  repaired: boolean
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  strategy: "auto_fragment_wrap" | null
  repairedNodeType?: string | null
  repairDiagnostic?: string | null
} {
  if (!diagnostic || !/adjacent jsx elements/i.test(diagnostic.message)) {
    return { repaired: false, files, changedFiles: [], strategy: null }
  }

  const targetPath = normalizePath(diagnostic.file)
  const target = files.find((file) => normalizePath(file.path) === targetPath)
  if (!target) return { repaired: false, files, changedFiles: [], strategy: null }

  const content = String(target.content || "")
  const repaired = repairAdjacentJsxWithAst(content, diagnostic)
  if (!repaired.ok || repaired.content === content) {
    return {
      repaired: false,
      files,
      changedFiles: [],
      strategy: null,
      repairDiagnostic: repaired.ok ? "No AST repair changed the file" : repaired.reason,
    }
  }

  const changed = { ...target, path: targetPath, content: repaired.content }
  return {
    repaired: true,
    files: files.map((file) => normalizePath(file.path) === targetPath ? changed : file),
    changedFiles: [changed],
    strategy: "auto_fragment_wrap",
    repairedNodeType: repaired.nodeType,
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

function repairAdjacentJsxWithAst(
  content: string,
  diagnostic: RuntimeSyntaxDiagnostic
): { ok: true; content: string; nodeType: string } | { ok: false; reason: string } {
  const offset = locationToOffset(content, diagnostic.line, diagnostic.column)
  const candidates = collectRepairRanges(content, offset)

  for (const candidate of candidates) {
    const inner = content.slice(candidate.start, candidate.end).trim()
    if (!inner || /^<>\s*[\s\S]*<\/>$/.test(inner)) continue
    if ((inner.match(/<([A-Za-z][\w.]*)\b/g) || []).length < 2) continue

    const repairedContent = `${content.slice(0, candidate.start)}<>\n${indentBlock(inner, "  ")}\n</>${content.slice(candidate.end)}`
    const ast = parseRuntimeFile(repairedContent)
    if (!ast.ok) continue
    const generated = generate(ast.ast as never, {
      retainLines: true,
      comments: true,
      jsescOption: { minimal: true },
    }).code
    const validation = parseRuntimeFile(generated)
    if (validation.ok) {
      return {
        ok: true,
        content: generated.endsWith("\n") ? generated : `${generated}\n`,
        nodeType: candidate.nodeType,
      }
    }
  }

  return { ok: false, reason: "Unable to find an AST-safe JSX sibling range to wrap in a fragment" }
}

function parseRuntimeFile(content: string) {
  try {
    return {
      ok: true as const,
      ast: parse(content, {
        sourceType: "module",
        errorRecovery: false,
        plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
      }),
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function collectRepairRanges(content: string, offset: number) {
  const ranges: Array<{ start: number; end: number; nodeType: string }> = []
  const paren = findEnclosingParens(content, offset)
  if (paren) ranges.push({ start: paren.start + 1, end: paren.end, nodeType: "ParenthesizedExpression" })

  const returnRange = findKeywordExpressionRange(content, offset, "return")
  if (returnRange) ranges.push({ ...returnRange, nodeType: "ReturnStatement" })

  const assignmentRange = findAssignmentExpressionRange(content, offset)
  if (assignmentRange) ranges.push({ ...assignmentRange, nodeType: "VariableDeclarator" })

  const arrowRange = findArrowExpressionRange(content, offset)
  if (arrowRange) ranges.push({ ...arrowRange, nodeType: "ArrowFunctionExpression" })

  const seen = new Set<string>()
  return ranges.filter((range) => {
    const key = `${range.start}:${range.end}`
    if (range.start < 0 || range.end <= range.start || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function findEnclosingParens(content: string, offset: number) {
  const stack: number[] = []
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === "(") stack.push(index)
    if (char === ")") {
      const start = stack.pop()
      if (typeof start === "number" && start < offset && index >= offset) {
        return { start, end: index }
      }
    }
  }
  return null
}

function findKeywordExpressionRange(content: string, offset: number, keyword: string) {
  const before = content.slice(0, offset)
  const keywordIndex = before.lastIndexOf(keyword)
  if (keywordIndex < 0) return null
  const openParen = content.indexOf("(", keywordIndex)
  if (openParen < 0 || openParen > offset) return null
  const closeParen = findMatchingParen(content, openParen)
  if (closeParen < 0) return null
  return { start: openParen + 1, end: closeParen }
}

function findAssignmentExpressionRange(content: string, offset: number) {
  const before = content.slice(0, offset)
  const equalIndex = before.lastIndexOf("=")
  if (equalIndex < 0) return null
  const semicolonIndex = content.indexOf(";", offset)
  const lineEndIndex = content.indexOf("\n", offset)
  const endCandidates = [semicolonIndex, lineEndIndex].filter((value) => value > offset)
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : content.length
  return { start: equalIndex + 1, end }
}

function findArrowExpressionRange(content: string, offset: number) {
  const before = content.slice(0, offset)
  const arrowIndex = before.lastIndexOf("=>")
  if (arrowIndex < 0) return null
  const endCandidates = [content.indexOf(",", offset), content.indexOf(")", offset), content.indexOf("\n", offset)]
    .filter((value) => value > offset)
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : content.length
  return { start: arrowIndex + 2, end }
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

function locationToOffset(content: string, line: number | null, column: number | null) {
  if (!line || line < 1) return 0
  const lines = content.split(/\r?\n/)
  let offset = 0
  for (let index = 0; index < Math.min(line - 1, lines.length); index += 1) {
    offset += lines[index].length + 1
  }
  return Math.min(content.length, offset + Math.max(0, column || 0))
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
