import { parse } from "@babel/parser"
import type { GeneratedFile } from "@/lib/types"
import { buildProjectMemoryGraph } from "@/lib/ai/project-memory-graph"

export type SemanticEditOperation =
  | { type: "rename_component"; from: string; to: string }
  | { type: "update_prop"; component: string; prop: string; value: string }
  | { type: "move_hook"; hook: string; fromComponent: string; toComponent: string }
  | { type: "modify_metadata"; field: "title" | "description"; value: string }
  | { type: "update_route"; from: string; to: string }

export type SemanticEditDiagnostics = {
  operation: SemanticEditOperation | null
  impactedFiles: string[]
  dependencyImpact: Array<{ file: string; imports: string[]; importedBy: string[] }>
  routeImpact: Array<{ path: string; route: string; kind: string }>
  componentGraphImpact: Array<{ path: string; exports: string[]; hooks: string[] }>
  reason: string
}

export type SemanticEditPatchResult = {
  applied: boolean
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  patchSummary: string[]
  operation: SemanticEditOperation | null
  diagnostics: SemanticEditDiagnostics
  reason: string
}

type AstNode = Record<string, unknown> & {
  type?: string
  start?: number
  end?: number
  name?: unknown
  value?: unknown
}

type RangeEdit = {
  start: number
  end: number
  text: string
}

export function applySemanticScopedEdit(input: {
  prompt: string
  files: GeneratedFile[]
  affectedFiles: string[]
}): SemanticEditPatchResult {
  const operation = parseSemanticEditOperation(input.prompt)
  if (!operation) {
    return unchanged(input.files, null, "No semantic scoped edit operation matched.")
  }

  const scopedFiles = getScopedFiles(input.files, input.affectedFiles, operation)
  const changedFiles: GeneratedFile[] = []
  const patchSummary: string[] = []

  for (const file of scopedFiles) {
    const content = String(file.content || "")
    if (!/\.(tsx?|jsx?)$/i.test(file.path)) continue
    const ast = parseTsxAst(content)
    const edits = editsForOperation(ast, content, operation)
    if (edits.length === 0) continue

    changedFiles.push({
      ...file,
      path: normalizePath(file.path),
      content: applyRangeEdits(content, edits),
    })
    patchSummary.push(`${operation.type} in ${normalizePath(file.path)}`)
  }

  if (changedFiles.length === 0) {
    return unchanged(input.files, operation, `No AST-safe target found for ${operation.type}.`)
  }

  const changedByPath = new Map(changedFiles.map((file) => [normalizePath(file.path), file]))
  const files = input.files.map((file) => changedByPath.get(normalizePath(file.path)) || file)

  return {
    applied: true,
    files,
    changedFiles,
    patchSummary,
    operation,
    diagnostics: buildSemanticDiagnostics(files, changedFiles.map((file) => normalizePath(file.path)), operation, "Applied AST semantic scoped edit."),
    reason: "Applied AST semantic scoped edit.",
  }
}

export function buildSemanticEditDiagnostics(input: {
  files: GeneratedFile[]
  changedFiles: GeneratedFile[]
  operation: SemanticEditOperation | null
  reason: string
}) {
  return buildSemanticDiagnostics(
    input.files,
    input.changedFiles.map((file) => normalizePath(file.path)),
    input.operation,
    input.reason
  )
}

function parseSemanticEditOperation(prompt: string): SemanticEditOperation | null {
  const text = String(prompt || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim()

  const rename = text.match(/\brename\s+(?:component\s+)?([A-Z][A-Za-z0-9_]*)\s+(?:to|jadi|menjadi)\s+([A-Z][A-Za-z0-9_]*)/i)
  if (rename?.[1] && rename?.[2]) {
    return { type: "rename_component", from: rename[1], to: rename[2] }
  }

  const prop = text.match(/\b(?:update|set|ubah)\s+(?:prop\s+)?([A-Z][A-Za-z0-9_]*)\.([A-Za-z_$][\w$-]*)\s+(?:to|jadi|menjadi)\s+"([^"]+)"/i)
  if (prop?.[1] && prop?.[2] && prop?.[3]) {
    return { type: "update_prop", component: prop[1], prop: prop[2], value: prop[3] }
  }

  const hook = text.match(/\bmove\s+hook\s+(use[A-Z][A-Za-z0-9_]*)\s+from\s+([A-Z][A-Za-z0-9_]*)\s+to\s+([A-Z][A-Za-z0-9_]*)/i)
  if (hook?.[1] && hook?.[2] && hook?.[3]) {
    return { type: "move_hook", hook: hook[1], fromComponent: hook[2], toComponent: hook[3] }
  }

  const metadata = text.match(/\b(?:modify|update|ubah|set)\s+metadata\s+(title|description)\s+(?:to|jadi|menjadi)\s+"([^"]+)"/i)
  if (metadata?.[1] && metadata?.[2]) {
    return { type: "modify_metadata", field: metadata[1].toLowerCase() as "title" | "description", value: metadata[2] }
  }

  const route = text.match(/\b(?:update|rename|ubah)\s+route\s+"([^"]+)"\s+(?:to|jadi|menjadi)\s+"([^"]+)"/i)
  if (route?.[1] && route?.[2]) {
    return { type: "update_route", from: normalizeRoute(route[1]), to: normalizeRoute(route[2]) }
  }

  return null
}

function editsForOperation(ast: AstNode, content: string, operation: SemanticEditOperation) {
  if (operation.type === "rename_component") return renameComponentEdits(ast, operation.from, operation.to)
  if (operation.type === "update_prop") return updatePropEdits(ast, content, operation)
  if (operation.type === "move_hook") return moveHookEdits(ast, content, operation)
  if (operation.type === "modify_metadata") return modifyMetadataEdits(ast, operation.field, operation.value)
  if (operation.type === "update_route") return updateRouteEdits(ast, operation.from, operation.to)
  return []
}

function renameComponentEdits(ast: AstNode, from: string, to: string) {
  const edits: RangeEdit[] = []
  walkAst(ast, [], (node) => {
    if ((node.type === "Identifier" || node.type === "JSXIdentifier") && node.name === from && isRangeNode(node)) {
      edits.push({ start: node.start, end: node.end, text: to })
    }
  })
  return edits
}

function updatePropEdits(ast: AstNode, content: string, operation: Extract<SemanticEditOperation, { type: "update_prop" }>) {
  const edits: RangeEdit[] = []
  walkAst(ast, [], (node) => {
    if (node.type !== "JSXOpeningElement") return
    const name = node.name as AstNode | undefined
    if (name?.type !== "JSXIdentifier" || name.name !== operation.component) return
    const attributes = Array.isArray(node.attributes) ? node.attributes as AstNode[] : []
    const existing = attributes.find((attribute) => {
      const attrName = attribute.name as AstNode | undefined
      return attribute.type === "JSXAttribute" && attrName?.type === "JSXIdentifier" && attrName.name === operation.prop
    })
    if (existing && isRangeNode(existing)) {
      edits.push({ start: existing.start, end: existing.end, text: `${operation.prop}="${escapeAttribute(operation.value)}"` })
      return
    }
    if (typeof node.end === "number") {
      const closeOffset = content.slice(0, node.end).lastIndexOf("/>")
      const bracketOffset = closeOffset >= 0 ? closeOffset : content.slice(0, node.end).lastIndexOf(">")
      if (bracketOffset >= 0) {
        edits.push({ start: bracketOffset, end: bracketOffset, text: ` ${operation.prop}="${escapeAttribute(operation.value)}"` })
      }
    }
  })
  return edits
}

function moveHookEdits(ast: AstNode, content: string, operation: Extract<SemanticEditOperation, { type: "move_hook" }>) {
  const fromBody = findComponentBody(ast, operation.fromComponent)
  const toBody = findComponentBody(ast, operation.toComponent)
  if (!fromBody || !toBody || typeof toBody.start !== "number") return []

  const statement = findHookStatement(fromBody, operation.hook)
  if (!statement || !isRangeNode(statement)) return []
  const hookSource = content.slice(statement.start, statement.end)
  return [
    { start: statement.start, end: statement.end, text: "" },
    { start: toBody.start + 1, end: toBody.start + 1, text: `\n  ${hookSource.trim()}` },
  ]
}

function modifyMetadataEdits(ast: AstNode, field: "title" | "description", value: string) {
  const edits: RangeEdit[] = []
  walkAst(ast, [], (node, parents) => {
    if (node.type !== "ObjectProperty") return
    const key = node.key as AstNode | undefined
    if (!key || key.name !== field) return
    if (!parents.some((parent) => parent.type === "VariableDeclarator" && (parent.id as AstNode | undefined)?.name === "metadata")) return
    const nodeValue = node.value as AstNode | undefined
    if (nodeValue && isRangeNode(nodeValue)) {
      edits.push({ start: nodeValue.start, end: nodeValue.end, text: JSON.stringify(value) })
    }
  })
  return edits
}

function updateRouteEdits(ast: AstNode, from: string, to: string) {
  const edits: RangeEdit[] = []
  walkAst(ast, [], (node, parents) => {
    const inNavigationProp = parents.some((parent) => {
      const name = parent.type === "JSXAttribute" ? parent.name as AstNode | undefined : null
      return name?.type === "JSXIdentifier" && (name.name === "href" || name.name === "to")
    })
    if ((node.type === "StringLiteral" || node.type === "DirectiveLiteral") && node.value === from && isRangeNode(node) && inNavigationProp) {
      edits.push({ start: node.start, end: node.end, text: JSON.stringify(to) })
    }
  })
  return edits
}

function findComponentBody(ast: AstNode, componentName: string): AstNode | null {
  let body: AstNode | null = null
  walkAst(ast, [], (node) => {
    if (body) return
    if (node.type === "FunctionDeclaration" && (node.id as AstNode | undefined)?.name === componentName) {
      body = node.body as AstNode
    }
    if (node.type === "VariableDeclarator" && (node.id as AstNode | undefined)?.name === componentName) {
      const init = node.init as AstNode | undefined
      if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") {
        body = init.body as AstNode
      }
    }
  })
  return body
}

function findHookStatement(body: AstNode, hookName: string): AstNode | null {
  const statements = Array.isArray(body.body) ? body.body as AstNode[] : []
  return statements.find((statement) => {
    let found = false
    walkAst(statement, [], (node) => {
      const callee = node.callee as AstNode | undefined
      if (node.type === "CallExpression" && callee?.type === "Identifier" && callee.name === hookName) found = true
    })
    return found
  }) || null
}

function getScopedFiles(files: GeneratedFile[], affectedFiles: string[], operation: SemanticEditOperation) {
  const affected = new Set(affectedFiles.map(normalizePath))
  if (operation.type === "rename_component") {
    return files.filter((file) => /\.(tsx?|jsx?)$/i.test(file.path) && (affected.has(normalizePath(file.path)) || String(file.content || "").includes(operation.from)))
  }
  if (operation.type === "modify_metadata") {
    return files.filter((file) => normalizePath(file.path) === "app/layout.tsx" || affected.has(normalizePath(file.path)))
  }
  return files.filter((file) => affected.has(normalizePath(file.path)))
}

function buildSemanticDiagnostics(files: GeneratedFile[], impactedFiles: string[], operation: SemanticEditOperation | null, reason: string): SemanticEditDiagnostics {
  const memory = buildProjectMemoryGraph({ files })
  const impacted = new Set(impactedFiles)
  return {
    operation,
    impactedFiles,
    dependencyImpact: memory.dependencies.filter((item) => impacted.has(item.file) || item.imports.some((file) => impacted.has(file)) || item.importedBy.some((file) => impacted.has(file))),
    routeImpact: memory.routeGraph.filter((route) => impacted.has(route.path)),
    componentGraphImpact: memory.componentGraph
      .filter((component) => impacted.has(component.path))
      .map((component) => ({ path: component.path, exports: component.exports, hooks: component.hooks })),
    reason,
  }
}

function parseTsxAst(content: string) {
  return parse(String(content || ""), {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "dynamicImport", "importAttributes", "decorators-legacy"],
  }) as unknown as AstNode
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

function applyRangeEdits(content: string, edits: RangeEdit[]) {
  let next = content
  const sorted = edits
    .filter((edit) => edit.start <= edit.end)
    .sort((a, b) => b.start - a.start)
  for (const edit of sorted) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`
  }
  return next
}

function isRangeNode(node: AstNode): node is AstNode & { start: number; end: number } {
  return typeof node.start === "number" && typeof node.end === "number"
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function normalizeRoute(value: string) {
  const normalized = String(value || "").trim()
  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function unchanged(files: GeneratedFile[], operation: SemanticEditOperation | null, reason: string): SemanticEditPatchResult {
  return {
    applied: false,
    files,
    changedFiles: [],
    patchSummary: [],
    operation,
    diagnostics: buildSemanticDiagnostics(files, [], operation, reason),
    reason,
  }
}
