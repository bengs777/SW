import { parse } from "@babel/parser"
import type { GeneratedFile } from "@/lib/types"

export type PreviewModuleGraph = {
  entry: string
  files: Record<string, string>
  importMap: Record<string, string>
  shims: Record<string, string>
  css: string
  warnings: string[]
}

export type AliasDiagnostic = {
  phase: string
  file: string
  match: string
  snippet: string
}

type FileRecord = {
  path: string
  content: string
}

type ImportRecord = {
  source: string
  start: number
  end: number
  statementStart: number
  statementEnd: number
  isTypeOnly: boolean
}

type AstNodeRecord = Record<string, unknown> & {
  type?: string
  source?: AstNodeRecord
  callee?: AstNodeRecord
  arguments?: AstNodeRecord[]
  importKind?: string
  exportKind?: string
  value?: string
  start?: number | null
  end?: number | null
}

type ImportSourceNode = AstNodeRecord & {
  type: "StringLiteral"
  value: string
}

type ResolveResult =
  | { kind: "local"; path: string; specifier: string; isStyle: boolean }
  | { kind: "external"; packageName: string; specifier: string }
  | { kind: "unsupported"; specifier: string; reason: string }
  | { kind: "missing"; specifier: string; candidates: string[] }

const CODE_FILE_RE = /\.(?:tsx?|jsx?|mjs|cjs)$/i
const CSS_FILE_RE = /\.css$/i
const JSON_FILE_RE = /\.json$/i
const STYLE_FILE_RE = /\.(?:css|scss|sass|less)$/i
const ASSET_FILE_RE = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf)$/i
const EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", ".css"]
const INDEX_EXTENSIONS = ["/index.tsx", "/index.ts", "/index.jsx", "/index.js", "/index.json"]
const LOCAL_PREFIX = "/@preview/"
const REACT_VERSION = "19.2.5"
const REACT_DOM_VERSION = "19.2.5"
const ESM_REACT_DEPS = `deps=react@${REACT_VERSION},react-dom@${REACT_DOM_VERSION}`

const CORE_IMPORTS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]

export const CDN_IMPORTS: Record<string, string> = {
  react: `https://esm.sh/react@${REACT_VERSION}`,
  "react-dom": `https://esm.sh/react-dom@${REACT_DOM_VERSION}?deps=react@${REACT_VERSION}`,
  "react-dom/client": `https://esm.sh/react-dom@${REACT_DOM_VERSION}/client?deps=react@${REACT_VERSION}`,
  "react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
  "react/jsx-dev-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-dev-runtime`,
  "react-is": "https://esm.sh/react-is@19",
  scheduler: "https://esm.sh/scheduler",
  "lucide-react": "https://esm.sh/lucide-react@0.564.0",
  clsx: "https://esm.sh/clsx@2",
  "tailwind-merge": "https://esm.sh/tailwind-merge@3",
  "class-variance-authority": "https://esm.sh/class-variance-authority@0.7",
  zod: "https://esm.sh/zod@3",
  "date-fns": "https://esm.sh/date-fns@4",
  recharts: "https://esm.sh/recharts@2",
  "framer-motion": "https://esm.sh/framer-motion@11",
  "@radix-ui/react-slot": "https://esm.sh/@radix-ui/react-slot@1",
  "@radix-ui/react-tabs": "https://esm.sh/@radix-ui/react-tabs@1",
  "@radix-ui/react-dialog": "https://esm.sh/@radix-ui/react-dialog@1",
  "@radix-ui/react-dropdown-menu": "https://esm.sh/@radix-ui/react-dropdown-menu@2",
  "@radix-ui/react-select": "https://esm.sh/@radix-ui/react-select@2",
  "@radix-ui/react-popover": "https://esm.sh/@radix-ui/react-popover@1",
  "@radix-ui/react-toast": "https://esm.sh/@radix-ui/react-toast@1",
  "@radix-ui/react-label": "https://esm.sh/@radix-ui/react-label@2",
  "@radix-ui/react-avatar": "https://esm.sh/@radix-ui/react-avatar@1",
  "@radix-ui/react-alert-dialog": "https://esm.sh/@radix-ui/react-alert-dialog@1",
  "@radix-ui/react-checkbox": "https://esm.sh/@radix-ui/react-checkbox@1",
  "@radix-ui/react-collapsible": "https://esm.sh/@radix-ui/react-collapsible@1",
  "@radix-ui/react-context-menu": "https://esm.sh/@radix-ui/react-context-menu@2",
  "@radix-ui/react-hover-card": "https://esm.sh/@radix-ui/react-hover-card@1",
  "@radix-ui/react-menubar": "https://esm.sh/@radix-ui/react-menubar@1",
  "@radix-ui/react-navigation-menu": "https://esm.sh/@radix-ui/react-navigation-menu@1",
  "@radix-ui/react-progress": "https://esm.sh/@radix-ui/react-progress@1",
  "@radix-ui/react-radio-group": "https://esm.sh/@radix-ui/react-radio-group@1",
  "@radix-ui/react-scroll-area": "https://esm.sh/@radix-ui/react-scroll-area@1",
  "@radix-ui/react-separator": "https://esm.sh/@radix-ui/react-separator@1",
  "@radix-ui/react-slider": "https://esm.sh/@radix-ui/react-slider@1",
  "@radix-ui/react-switch": "https://esm.sh/@radix-ui/react-switch@1",
  "@radix-ui/react-toggle": "https://esm.sh/@radix-ui/react-toggle@1",
  "@radix-ui/react-toggle-group": "https://esm.sh/@radix-ui/react-toggle-group@1",
  "@radix-ui/react-tooltip": "https://esm.sh/@radix-ui/react-tooltip@1",
  "@radix-ui/react-popper": "https://esm.sh/@radix-ui/react-popper@1",
  "@radix-ui/react-portal": "https://esm.sh/@radix-ui/react-portal@1",
  "@radix-ui/react-primitive": "https://esm.sh/@radix-ui/react-primitive@1",
  "react-hook-form": "https://esm.sh/react-hook-form@7",
  "@hookform/resolvers": "https://esm.sh/@hookform/resolvers@3",
  "@tanstack/react-table": "https://esm.sh/@tanstack/react-table@8",
  "@tanstack/react-query": "https://esm.sh/@tanstack/react-query@5",
  sonner: "https://esm.sh/sonner@1",
  "embla-carousel-react": "https://esm.sh/embla-carousel-react@8",
  "embla-carousel": "https://esm.sh/embla-carousel@8",
  cmdk: "https://esm.sh/cmdk@1",
  vaul: "https://esm.sh/vaul@1",
  zustand: "https://esm.sh/zustand@5",
  viem: "https://esm.sh/viem@2",
  ethers: "https://esm.sh/ethers@6",
}

export const SHIM_MODULES: Record<string, string> = {
  "next/link": `
    import React from "react";
    export default function Link(props) {
      const { href = "#", children, prefetch, replace, scroll, shallow, locale, ...rest } = props || {};
      const resolvedHref = typeof href === "string" ? href : href && href.pathname ? href.pathname : "#";
      return React.createElement("a", { ...rest, href: resolvedHref }, children);
    }
  `,
  "next/image": `
    import React from "react";
    export default function Image(props) {
      const { src = "", alt = "", width, height, fill, priority, quality, sizes, loader, ...rest } = props || {};
      const style = { ...(rest.style || {}) };
      if (fill) Object.assign(style, { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: rest.objectFit || "cover" });
      return React.createElement("img", { ...rest, src: typeof src === "string" ? src : src && src.src ? src.src : "", alt, width: fill ? undefined : width, height: fill ? undefined : height, style });
    }
  `,
  "next/navigation": `
    const noop = function(){};
    const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop };
    export function useRouter(){ return router; }
    export function usePathname(){ return "/"; }
    export function useSearchParams(){ return new URLSearchParams(""); }
    export function useParams(){ return {}; }
    export function redirect(){ throw new Error("next/navigation redirect() is not available in preview."); }
    export function notFound(){ throw new Error("next/navigation notFound() is not available in preview."); }
  `,
  "next/font/google": `
    function makeFont() { return { className: "", variable: "", style: {} }; }
    export const Inter = makeFont;
    export const Geist = makeFont;
    export const Roboto = makeFont;
    export const Poppins = makeFont;
    export const Montserrat = makeFont;
    export const Lato = makeFont;
    export const Open_Sans = makeFont;
    export const Playfair_Display = makeFont;
    export const Space_Grotesk = makeFont;
    export const Manrope = makeFont;
  `,
}

const UNSUPPORTED_IMPORTS = new Map<string, string>([
  ["fs", "Node filesystem APIs are not available in the browser preview."],
  ["node:fs", "Node filesystem APIs are not available in the browser preview."],
  ["path", "Node path APIs are not available in the browser preview."],
  ["node:path", "Node path APIs are not available in the browser preview."],
  ["crypto", "Node crypto APIs are not available in the browser preview."],
  ["node:crypto", "Node crypto APIs are not available in the browser preview."],
  ["child_process", "Process execution APIs are not available in the browser preview."],
  ["node:child_process", "Process execution APIs are not available in the browser preview."],
  ["worker_threads", "Node worker threads are not available in the browser preview."],
  ["node:worker_threads", "Node worker threads are not available in the browser preview."],
  ["net", "Node networking APIs are not available in the browser preview."],
  ["node:net", "Node networking APIs are not available in the browser preview."],
  ["tls", "Node TLS APIs are not available in the browser preview."],
  ["node:tls", "Node TLS APIs are not available in the browser preview."],
  ["next/headers", "next/headers is server-only and cannot run in the browser preview."],
  ["next/cookies", "next/cookies is server-only and cannot run in the browser preview."],
  ["next/server", "next/server route helpers are not available in the browser preview."],
  ["@prisma/client", "Prisma runs on the server and cannot execute inside the browser preview."],
  ["sharp", "Native image processing packages cannot execute inside the browser preview."],
  ["puppeteer", "Browser automation packages cannot execute inside the browser preview."],
  ["playwright", "Browser automation packages cannot execute inside the browser preview."],
  ["canvas", "Native canvas packages cannot execute inside the browser preview."],
  ["bcrypt", "Native hashing packages cannot execute inside the browser preview."],
  ["bcryptjs", "Password hashing packages should not execute inside the browser preview."],
])

const LOCAL_FALLBACK_MODULES: Record<string, string> = {
  "lib/utils.ts": `
    function append(out, value) {
      if (!value) return;
      if (typeof value === "string" || typeof value === "number") out.push(String(value));
      else if (Array.isArray(value)) value.forEach(function(item){ append(out, item); });
      else if (typeof value === "object") Object.keys(value).forEach(function(key){ if (value[key]) out.push(key); });
    }
    export function cn() {
      var out = [];
      Array.prototype.forEach.call(arguments, function(value){ append(out, value); });
      return out.join(" ");
    }
  `,
  "hooks/use-toast.ts": `
    export function useToast() {
      return {
        toast(toast) {
          console.log("[preview toast]", toast);
        },
        dismiss() {},
      };
    }
  `,
  "hooks/use-mobile.ts": `
    import { useEffect, useState } from "react";
    export function useMobile(breakpoint = 768) {
      const [isMobile, setIsMobile] = useState(false);
      useEffect(function(){
        const update = function(){ setIsMobile(window.innerWidth < breakpoint); };
        update();
        window.addEventListener("resize", update);
        return function(){ window.removeEventListener("resize", update); };
      }, [breakpoint]);
      return isMobile;
    }
  `,
  "components/ui/button.tsx": `
    export function Button(props) {
      const { className = "", variant, size, asChild, ...rest } = props || {};
      return <button className={"inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium " + className} {...rest} />;
    }
  `,
}

export function buildPreviewModuleGraph(files: GeneratedFile[]): PreviewModuleGraph {
  const index = createFileIndex(files)
  const entry = guessEntryFile(index)
  if (!entry) {
    throw new Error("No entry file found. Expected app/page.tsx, src/app/page.tsx, src/App.tsx, or index.tsx")
  }

  const graphFiles: Record<string, string> = {}
  const importMap: Record<string, string> = {}
  const shims: Record<string, string> = {}
  const cssPaths = new Set<string>()
  const orderedCssPaths: string[] = []
  const warnings: string[] = []
  const missing: string[] = []
  const unsupported: string[] = []
  const externalPackages = new Set(CORE_IMPORTS)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const cycles = new Set<string>()

  const visit = (filePath: string) => {
    if (visited.has(filePath)) return

    if (visiting.has(filePath)) {
      const cycleStart = stack.indexOf(filePath)
      const cycle = [...stack.slice(Math.max(0, cycleStart)), filePath].join(" -> ")
      cycles.add(cycle)
      return
    }

    const record = index.files.get(filePath) || createFallbackRecord(filePath)
    if (!record) {
      missing.push(filePath)
      return
    }

    visiting.add(filePath)
    stack.push(filePath)

    try {
      if (STYLE_FILE_RE.test(filePath)) {
        addCssPath(filePath)
        graphFiles[filePath] = buildCssModule(record.content)
        return
      }

      if (ASSET_FILE_RE.test(filePath)) {
        graphFiles[filePath] = buildAssetModule(record.content, filePath)
        return
      }

      if (JSON_FILE_RE.test(filePath)) {
        graphFiles[filePath] = buildJsonModule(record.content, filePath)
        return
      }

      if (!isExecutableFile(filePath)) {
        return
      }

      const preTransformDiagnostics = collectUnresolvedAliasDiagnostics(record.content, filePath, "pre-transform")
      const imports = parseImports(record.content, filePath)
      const replacements: Array<{ start: number; end: number; value: string }> = []

      for (const imported of imports) {
        const resolved = resolveImport(filePath, imported.source, index)
        if (resolved.kind === "local") {
          replacements.push({
            start: imported.start,
            end: imported.end,
            value: JSON.stringify(resolved.specifier),
          })

          if (imported.isTypeOnly) {
            continue
          }

          if (resolved.isStyle) {
            addCssPath(resolved.path)
          }

          visit(resolved.path)
          continue
        }

        if (resolved.kind === "external") {
          externalPackages.add(resolved.packageName)
          continue
        }

        if (imported.isTypeOnly) {
          const typeOnlyLocal = unresolvedTypeOnlyLocalSpecifier(filePath, imported.source)
          if (typeOnlyLocal) {
            replacements.push({
              start: imported.start,
              end: imported.end,
              value: JSON.stringify(typeOnlyLocal),
            })
          }
          continue
        }

        if (resolved.kind === "unsupported") {
          unsupported.push(`${filePath}: ${resolved.specifier} - ${resolved.reason}`)
          continue
        }

        missing.push(
          `${filePath}: ${resolved.specifier}` +
            (resolved.candidates.length > 0 ? ` (tried ${resolved.candidates.join(", ")})` : "")
        )
      }

      const transformed = applyReplacements(record.content, replacements)
      const postTransformDiagnostics = collectUnresolvedAliasDiagnostics(transformed, filePath, "post-transform")
      if (postTransformDiagnostics.length > 0) {
        throw createUnresolvedAliasError([
          ...postTransformDiagnostics,
          ...preTransformDiagnostics.map((diagnostic) => ({
            ...diagnostic,
            snippet: phaseSnapshot(record.content, diagnostic.match),
          })),
        ])
      }

      graphFiles[filePath] = transformed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Import analysis failed in ${filePath}: ${message}`)
    } finally {
      stack.pop()
      visiting.delete(filePath)
      visited.add(filePath)
    }
  }

  visit(entry)

  for (const cycle of cycles) {
    warnings.push(`Circular dependency detected: ${cycle}`)
  }

  if (cycles.size > 0) {
    throw new Error(`CIRCULAR_DEPENDENCY_DETECTED\n${Array.from(cycles).join("\n")}`)
  }

  if (unsupported.length > 0) {
    throw new Error(`Unsupported imports for browser preview:\n${unsupported.join("\n")}`)
  }

  if (missing.length > 0) {
    throw new Error(`Missing local preview modules:\n${Array.from(new Set(missing)).join("\n")}`)
  }

  for (const packageName of externalPackages) {
    if (SHIM_MODULES[packageName]) {
      shims[packageName] = SHIM_MODULES[packageName]
    } else {
      importMap[packageName] = resolveCdnUrl(packageName)
    }
  }

  for (const [path, content] of Object.entries(LOCAL_FALLBACK_MODULES)) {
    if (graphFiles[path] !== undefined) continue
    if (visited.has(path)) {
      graphFiles[path] = content
    }
  }

  for (const path of getGlobalCssPaths(index.files)) {
    addCssPath(path)
  }

  const css = orderedCssPaths
    .map((path) => {
      const record = index.files.get(path)
      return record ? `\n/* ${path} */\n${record.content}` : ""
    })
    .join("\n")

  return validateCompiledGraph({
    entry,
    files: graphFiles,
    importMap,
    shims,
    css,
    warnings,
  })

  function addCssPath(path: string) {
    if (cssPaths.has(path)) return
    cssPaths.add(path)
    orderedCssPaths.push(path)
  }
}

export function compileProject(files: GeneratedFile[]): PreviewModuleGraph {
  return buildPreviewModuleGraph(files)
}

export function previewSpecifierForPath(path: string) {
  return `${LOCAL_PREFIX}${normalizePath(path)}`
}

function validateCompiledGraph(graph: PreviewModuleGraph): PreviewModuleGraph {
  const diagnostics: AliasDiagnostic[] = []

  for (const [path, code] of Object.entries(graph.files)) {
    diagnostics.push(...collectUnresolvedAliasDiagnostics(code, path, "pre-validation"))
  }

  for (const [specifier, code] of Object.entries(graph.shims)) {
    diagnostics.push(...collectUnresolvedAliasDiagnostics(code, `shim:${specifier}`, "pre-validation"))
  }

  if (diagnostics.length > 0) {
    throw createUnresolvedAliasError(diagnostics)
  }

  return graph
}

export function containsUnresolvedAlias(code: string) {
  return collectUnresolvedAliasDiagnostics(code, "unknown", "validation").length > 0
}

export function collectUnresolvedAliasDiagnostics(
  code: string,
  file: string,
  phase: string
): AliasDiagnostic[] {
  if (!isExecutableFile(file) && !file.startsWith("shim:") && file !== "unknown") {
    return []
  }

  let imports: ImportRecord[]
  try {
    imports = parseImports(String(code || ""), file)
  } catch {
    return []
  }

  return imports
    .filter((record) => isAliasSpecifier(record.source))
    .map((record) => ({
      phase,
      file,
      match: statementForRange(code, record.statementStart, record.statementEnd),
      snippet: snippetForRange(code, record.statementStart, record.statementEnd),
    }))
}

function createUnresolvedAliasError(diagnostics: AliasDiagnostic[]) {
  const unique = dedupeDiagnostics(diagnostics)
  return new Error(`UNRESOLVED_ALIAS_DETECTED\n${JSON.stringify(unique, null, 2)}`)
}

function dedupeDiagnostics(diagnostics: AliasDiagnostic[]) {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.phase}:${diagnostic.file}:${diagnostic.match}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function statementForRange(code: string, start: number, end: number) {
  return String(code || "").slice(Math.max(0, start), Math.max(start, end)).trim()
}

function snippetForRange(code: string, start: number, end: number) {
  const source = String(code || "")
  const safeStart = Math.max(0, start)
  const safeEnd = Math.max(safeStart, end)
  const lineStart = source.lastIndexOf("\n", safeStart)
  const nextLine = source.indexOf("\n", safeEnd)
  return source.slice(lineStart < 0 ? 0 : lineStart + 1, nextLine < 0 ? source.length : nextLine).trim()
}

function phaseSnapshot(code: string, match: string) {
  const source = String(code || "")
  const index = source.indexOf(match)
  if (index < 0) return source.slice(0, 240)
  return snippetForRange(source, index, index + match.length)
}

function createFileIndex(files: GeneratedFile[]) {
  const fileMap = new Map<string, FileRecord>()
  const lookup = new Map<string, string>()

  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (!normalized) continue

    const record = {
      path: normalized,
      content: String(file.content || ""),
    }
    fileMap.set(normalized, record)
    lookup.set(normalized.toLowerCase(), normalized)

    for (const key of importKeysForPath(normalized)) {
      lookup.set(key.toLowerCase(), normalized)
    }
  }

  for (const fallbackPath of Object.keys(LOCAL_FALLBACK_MODULES)) {
    if (fileMap.has(fallbackPath)) continue
    for (const key of importKeysForPath(fallbackPath)) {
      if (!lookup.has(key.toLowerCase())) {
        lookup.set(key.toLowerCase(), fallbackPath)
      }
    }
  }

  return {
    files: fileMap,
    lookup,
  }
}

function parseImports(code: string, filePath: string): ImportRecord[] {
  const ast = parse(code, {
    sourceType: "module",
    errorRecovery: false,
    allowImportExportEverywhere: true,
    plugins: [
      "jsx",
      "typescript",
      "dynamicImport",
      "importAttributes",
      "importMeta",
      "topLevelAwait",
      "decorators-legacy",
    ],
  })

  const imports: ImportRecord[] = []

  traverseAst(ast, (node) => {
    if (node.type === "ImportDeclaration" && isStringLiteralNode(node.source)) {
      imports.push(readImportRecord(node.source, node, node.importKind === "type"))
      return
    }

    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      isStringLiteralNode(node.source)
    ) {
      imports.push(readImportRecord(node.source, node, node.exportKind === "type"))
      return
    }

    if (node.type === "ImportExpression" && isStringLiteralNode(node.source)) {
      imports.push(readImportRecord(node.source, node, false))
      return
    }

    if (node.type === "ImportExpression" && node.source && !isStringLiteralNode(node.source)) {
      throw new Error(`Dynamic import in ${filePath} must use a static string literal.`)
    }

    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      isStringLiteralNode(node.arguments?.[0])
    ) {
      imports.push(readImportRecord(node.arguments[0], node, false))
      return
    }

    if (node.type === "CallExpression" && node.callee?.type === "Import") {
      throw new Error(`Dynamic import in ${filePath} must use a static string literal.`)
    }
  })

  return imports.filter((item) => item.start >= 0 && item.end > item.start && item.source.trim())
}

function readImportRecord(sourceNode: ImportSourceNode, statementNode: AstNodeRecord, isTypeOnly: boolean) {
  return {
    source: sourceNode.value,
    start: typeof sourceNode.start === "number" ? sourceNode.start : -1,
    end: typeof sourceNode.end === "number" ? sourceNode.end : -1,
    statementStart: typeof statementNode.start === "number" ? statementNode.start : -1,
    statementEnd: typeof statementNode.end === "number" ? statementNode.end : -1,
    isTypeOnly,
  }
}

function isStringLiteralNode(node: unknown): node is ImportSourceNode {
  if (!node || typeof node !== "object") return false
  const candidate = node as AstNodeRecord
  return candidate.type === "StringLiteral" && typeof candidate.value === "string"
}

function traverseAst(node: unknown, visit: (node: AstNodeRecord) => void) {
  if (!node || typeof node !== "object") return

  const current = node as AstNodeRecord
  if (typeof current.type === "string") {
    visit(current)
  }

  for (const [key, value] of Object.entries(current)) {
    if (
      key === "loc" ||
      key === "start" ||
      key === "end" ||
      key === "range" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        traverseAst(item, visit)
      }
      continue
    }

    if (value && typeof value === "object") {
      traverseAst(value, visit)
    }
  }
}

function resolveImport(fromPath: string, source: string, index: ReturnType<typeof createFileIndex>): ResolveResult {
  const trimmed = source.trim()

  if (isRemoteSpecifier(trimmed)) {
    return { kind: "unsupported", specifier: trimmed, reason: "Remote module imports are not allowed in browser preview." }
  }

  if (SHIM_MODULES[trimmed]) {
    return { kind: "external", packageName: trimmed, specifier: trimmed }
  }

  const unsupportedReason = unsupportedReasonForSpecifier(trimmed)
  if (unsupportedReason) {
    return { kind: "unsupported", specifier: trimmed, reason: unsupportedReason }
  }

  const candidates = localCandidates(fromPath, trimmed)
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      const resolved = resolveCandidate(candidate, index)
      if (resolved) {
        return {
          kind: "local",
          path: resolved,
          specifier: previewSpecifierForPath(resolved),
          isStyle: STYLE_FILE_RE.test(resolved),
        }
      }
    }

    return { kind: "missing", specifier: trimmed, candidates }
  }

  if (!hasCdnImport(trimmed)) {
    return { kind: "unsupported", specifier: trimmed, reason: "External package is not allowlisted for browser preview." }
  }

  return { kind: "external", packageName: trimmed, specifier: trimmed }
}

function unresolvedTypeOnlyLocalSpecifier(fromPath: string, source: string) {
  const candidates = localCandidates(fromPath, source)
  if (candidates.length === 0) return null
  return previewSpecifierForPath(candidates[0])
}

function isAliasSpecifier(source: string) {
  return source.startsWith("@/") || source.startsWith("~/")
}

function localCandidates(fromPath: string, source: string) {
  const normalized = source.replace(/\\/g, "/")

  if (normalized.startsWith("@/") || normalized.startsWith("~/")) {
    const withoutAlias = normalized.slice(2)
    return [`src/${withoutAlias}`, withoutAlias].map(normalizePath)
  }

  if (normalized.startsWith("/")) {
    return [normalized.replace(/^\/+/, "")].map(normalizePath)
  }

  if (normalized.startsWith(".")) {
    return [joinPath(dirname(fromPath), normalized)]
  }

  return []
}

function resolveCandidate(candidate: string, index: ReturnType<typeof createFileIndex>) {
  for (const key of expandedImportKeys(candidate)) {
    const resolved = index.lookup.get(key.toLowerCase())
    if (resolved) return resolved
  }

  return null
}

function expandedImportKeys(path: string) {
  const normalized = normalizePath(path)
  const keys = new Set<string>([normalized])

  for (const ext of EXTENSIONS) {
    keys.add(`${normalized}${ext}`)
  }

  for (const ext of INDEX_EXTENSIONS) {
    keys.add(`${normalized}${ext}`)
  }

  return Array.from(keys)
}

function importKeysForPath(path: string) {
  const normalized = normalizePath(path)
  const stripped = stripExtension(normalized)
  const keys = new Set<string>([normalized, stripped])

  if (stripped.endsWith("/index")) {
    keys.add(stripped.slice(0, -"/index".length))
  }

  return Array.from(keys)
}

function applyReplacements(code: string, replacements: Array<{ start: number; end: number; value: string }>) {
  if (replacements.length === 0) return code

  let output = code
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`
  }
  return output
}

function resolveCdnUrl(specifier: string) {
  if (CDN_IMPORTS[specifier]) return withReactSingletonDeps(CDN_IMPORTS[specifier], specifier)

  const rootPackage = getPackageRoot(specifier)
  if (CDN_IMPORTS[rootPackage]) {
    const suffix = specifier.slice(rootPackage.length)
    return withReactSingletonDeps(`${CDN_IMPORTS[rootPackage]}${suffix}`, specifier)
  }

  throw new Error(`External package is not allowlisted for browser preview: ${specifier}`)
}

function hasCdnImport(specifier: string) {
  if (CDN_IMPORTS[specifier]) return true
  return Boolean(CDN_IMPORTS[getPackageRoot(specifier)])
}

function withReactSingletonDeps(url: string, specifier: string) {
  if (specifier === "react" || specifier.startsWith("react/")) {
    return url
  }

  if (specifier === "react-dom" || specifier.startsWith("react-dom/")) {
    return url.includes("deps=react@") ? url : appendQuery(url, `deps=react@${REACT_VERSION}`)
  }

  return url.includes("deps=react@") ? url : appendQuery(url, ESM_REACT_DEPS)
}

function appendQuery(url: string, query: string) {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`
}

function getPackageRoot(specifier: string) {
  if (!specifier.startsWith("@")) {
    return specifier.split("/")[0] || specifier
  }

  return specifier.split("/").slice(0, 2).join("/")
}

function unsupportedReasonForSpecifier(specifier: string) {
  if (UNSUPPORTED_IMPORTS.has(specifier)) {
    return UNSUPPORTED_IMPORTS.get(specifier) || "This package is not supported in browser preview."
  }

  const rootPackage = getPackageRoot(specifier)
  if (UNSUPPORTED_IMPORTS.has(rootPackage)) {
    return UNSUPPORTED_IMPORTS.get(rootPackage) || "This package is not supported in browser preview."
  }

  return null
}

function createFallbackRecord(path: string): FileRecord | null {
  const content = LOCAL_FALLBACK_MODULES[path]
  return content === undefined ? null : { path, content }
}

function isExecutableFile(path: string) {
  return CODE_FILE_RE.test(path)
}

function isRemoteSpecifier(source: string) {
  return source.startsWith("http://") || source.startsWith("https://") || source.startsWith("data:") || source.startsWith("blob:")
}

function buildCssModule(content: string) {
  return `const css = ${JSON.stringify(content)};\nexport default css;\n`
}

function getGlobalCssPaths(files: Map<string, FileRecord>) {
  const priority = [
    "app/globals.css",
    "src/app/globals.css",
    "styles/globals.css",
    "src/styles/globals.css",
    "globals.css",
  ]
  const output: string[] = []

  for (const path of priority) {
    if (files.has(path)) {
      output.push(path)
    }
  }

  for (const file of files.values()) {
    if (STYLE_FILE_RE.test(file.path) && !output.includes(file.path)) {
      output.push(file.path)
    }
  }

  return output
}

function buildAssetModule(content: string, path: string) {
  const mimeType = assetMimeType(path)
  const value = mimeType === "image/svg+xml"
    ? `data:${mimeType};utf8,${encodeURIComponent(content)}`
    : ""

  return `const assetUrl = ${JSON.stringify(value)};\nexport default assetUrl;\n`
}

function assetMimeType(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".avif")) return "image/avif"
  return "application/octet-stream"
}

function buildJsonModule(content: string, path: string): string {
  try {
    const parsed = JSON.parse(content)
    const namedExports =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed)
            .filter((key) => isIdentifierName(key))
            .map((key) => `export const ${key} = data[${JSON.stringify(key)}];`)
            .join("\n")
        : ""

    return `const data = ${JSON.stringify(parsed)};\n${namedExports}\nexport default data;`
  } catch {
    return `throw new Error(${JSON.stringify(`Invalid JSON in ${path}`)});`
  }
}

function isIdentifierName(value: string) {
  try {
    parse(`const ${value} = null`, { sourceType: "module" })
    return true
  } catch {
    return false
  }
}

function guessEntryFile(index: ReturnType<typeof createFileIndex>) {
  const priorities = [
    "app/page.tsx",
    "app/page.jsx",
    "src/app/page.tsx",
    "src/app/page.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "index.tsx",
    "index.jsx",
  ]

  for (const path of priorities) {
    const resolved = resolveCandidate(path, index)
    if (resolved) return resolved
  }

  for (const record of index.files.values()) {
    if (/\.(tsx|jsx)$/i.test(record.path)) {
      return record.path
    }
  }

  return null
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function stripExtension(filePath: string) {
  return normalizePath(filePath).replace(/\.(tsx?|jsx?|mjs|cjs|json|css)$/i, "")
}

function dirname(filePath: string) {
  const segments = normalizePath(filePath).split("/").filter(Boolean)
  segments.pop()
  return segments.join("/")
}

function joinPath(...parts: string[]) {
  const output: string[] = []

  for (const part of parts.join("/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      output.pop()
      continue
    }
    output.push(part)
  }

  return output.join("/")
}

export function normalizePreviewPath(path: string) {
  return normalizePath(path)
}

export function isPreviewCodeFile(path: string) {
  return CODE_FILE_RE.test(path) || CSS_FILE_RE.test(path) || JSON_FILE_RE.test(path)
}

export function isPreviewAssetFile(path: string) {
  return ASSET_FILE_RE.test(path)
}
