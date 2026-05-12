import type { GeneratedFile } from "@/lib/types"

export type NextJsIntegritySeverity = "error" | "warning"

export type NextJsIntegrityIssue = {
  code: string
  severity: NextJsIntegritySeverity
  message: string
  filePath: string
  data?: Record<string, unknown>
}

const SERVER_ONLY_IMPORTS = new Set([
  "fs",
  "node:fs",
  "path",
  "node:path",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "next/headers",
  "next/server",
  "@prisma/client",
])

const EDGE_INCOMPATIBLE_IMPORTS = new Set([
  "fs",
  "node:fs",
  "path",
  "node:path",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "@prisma/client",
  "bcrypt",
  "bcryptjs",
])

const CLIENT_HOOK_RE = /\b(useState|useEffect|useLayoutEffect|useRef|useReducer|useMemo|useCallback|useContext|useOptimistic|useTransition)\s*\(/m
const BROWSER_API_RE = /\b(window|document|localStorage|sessionStorage|navigator|HTMLElement|ResizeObserver|IntersectionObserver)\b/m
const SERVER_ACTION_RE = /["']use server["']/m
const CLIENT_DIRECTIVE_RE = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\/\/[^\n]*\n\s*)?["']use client["']\s*;?/m
const DYNAMIC_IMPORT_EXPRESSION_RE = /import\s*\(\s*(?!["'`])/m
const ENV_ACCESS_RE = /process\.env\.([A-Z0-9_]+)/g

export function analyzeNextJsIntegrity(files: GeneratedFile[]): NextJsIntegrityIssue[] {
  const issues: NextJsIntegrityIssue[] = []
  for (const file of files) {
    const path = normalizePath(file.path)
    const content = String(file.content || "")
    if (!/\.(tsx?|jsx?)$/i.test(path)) continue

    const isClient = hasUseClientDirective(content)
    const imports = collectImports(content)
    const isRouteHandler = /^app\/api\/.+\/route\.(ts|js)$/i.test(path)
    const isAppRouteFile = /^app\/.+\.(tsx|ts|jsx|js)$/i.test(path)

    if (isClient && /export\s+default\s+async\s+function\b/.test(content)) {
      issues.push(issue("client.async_component", path, "Client components must not be async default components."))
    }

    if (isClient && /\bexport\s+(?:const|async\s+function|function)\s+(metadata|generateMetadata|generateViewport)\b/.test(content)) {
      issues.push(issue("client.metadata_export", path, "Client components cannot export metadata or generateMetadata."))
    }

    if (isClient) {
      for (const imported of imports) {
        if (SERVER_ONLY_IMPORTS.has(packageRoot(imported))) {
          issues.push(issue("client.server_only_import", path, `Client component imports server-only module: ${imported}`, {
            specifier: imported,
          }))
        }
      }

      for (const envName of collectEnvAccess(content)) {
        if (!envName.startsWith("NEXT_PUBLIC_")) {
          issues.push(issue("client.env_leak", path, `Client component reads non-public environment variable: ${envName}`, {
            envName,
          }))
        }
      }
    }

    if (!isClient && !isRouteHandler && isAppRouteFile && CLIENT_HOOK_RE.test(content)) {
      issues.push(issue("server.missing_use_client", path, "File uses React client hooks but is not marked with \"use client\"."))
    }

    if (!isClient && !isRouteHandler && isAppRouteFile && BROWSER_API_RE.test(stripCommentsAndStrings(content))) {
      issues.push(issue("server.browser_api", path, "Server component appears to reference browser-only APIs."))
    }

    if (isClient && SERVER_ACTION_RE.test(content)) {
      issues.push(issue("client.inline_server_action", path, "Inline server actions are not allowed in client components."))
    }

    if (DYNAMIC_IMPORT_EXPRESSION_RE.test(content)) {
      issues.push(issue("next.dynamic_import_expression", path, "Dynamic imports must use a static string literal."))
    }

    if (/export\s+const\s+runtime\s*=\s*["']edge["']/.test(content)) {
      for (const imported of imports) {
        if (EDGE_INCOMPATIBLE_IMPORTS.has(packageRoot(imported))) {
          issues.push(issue("runtime.edge_incompatible_import", path, `Edge runtime file imports Node-only module: ${imported}`, {
            specifier: imported,
          }))
        }
      }
    }

    if (isRouteHandler) {
      issues.push(...validateRouteHandler(path, content))
    }
  }

  return issues
}

function validateRouteHandler(path: string, content: string): NextJsIntegrityIssue[] {
  const issues: NextJsIntegrityIssue[] = []
  if (CLIENT_DIRECTIVE_RE.test(content)) {
    issues.push(issue("route_handler.use_client", path, "Route handlers must not be client components."))
  }

  if (/export\s+default\s+/.test(content)) {
    issues.push(issue("route_handler.default_export", path, "Route handlers must not use default exports."))
  }

  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g)) {
    const name = match[1]
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) {
      issues.push(issue("route_handler.invalid_export", path, `Invalid route handler export: ${name}`, {
        exportName: name,
      }))
    }

    if (!/async\s+function/.test(match[0])) {
      issues.push({
        ...issue("route_handler.sync_handler", path, `Route handler ${name} should be async for predictable error handling.`, {
          exportName: name,
        }),
        severity: "warning",
      })
    }
  }

  return issues
}

function issue(code: string, filePath: string, message: string, data?: Record<string, unknown>): NextJsIntegrityIssue {
  return {
    code,
    severity: "error",
    message,
    filePath,
    data,
  }
}

function hasUseClientDirective(content: string) {
  return CLIENT_DIRECTIVE_RE.test(content)
}

function collectImports(content: string) {
  const imports = new Set<string>()
  const patterns = [
    /import(?:\s+type)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /export[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) imports.add(match[1].trim())
    }
  }

  return Array.from(imports)
}

function collectEnvAccess(content: string) {
  const envNames = new Set<string>()
  for (const match of content.matchAll(ENV_ACCESS_RE)) {
    if (match[1]) envNames.add(match[1])
  }
  return Array.from(envNames)
}

function packageRoot(specifier: string) {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/")
  }
  return specifier.split("/")[0] || specifier
}

function stripCommentsAndStrings(content: string) {
  return String(content || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "")
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}
