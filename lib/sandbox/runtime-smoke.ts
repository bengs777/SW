import type { GeneratedFile } from "@/lib/types"

export type RuntimeFailureCategory =
  | "playwright_unavailable"
  | "server_unreachable"
  | "homepage_render_failed"
  | "route_render_failed"
  | "api_route_failed"
  | "hydration_error"
  | "console_error"
  | "unhandled_exception"
  | "navigation_failed"
  | "timeout"

export type RuntimeSmokeCheck = {
  name: string
  status: "passed" | "failed" | "skipped"
  durationMs: number
  category?: RuntimeFailureCategory
  message?: string
  data?: Record<string, unknown>
}

export type RuntimeSmokeResult = {
  ok: boolean
  durationMs: number
  checks: RuntimeSmokeCheck[]
  failureCategory?: RuntimeFailureCategory
  error?: string
  routes: string[]
  apiRoutes: string[]
}

type SmokePage = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<{ status: () => number } | null>
  locator: (selector: string) => {
    innerText: (options?: Record<string, unknown>) => Promise<string>
  }
  on: (event: "console" | "pageerror", handler: (value: unknown) => void) => void
  evaluate: <T>(fn: (value: T) => void, value: T) => Promise<unknown>
  waitForTimeout: (milliseconds: number) => Promise<void>
  url: () => string
}

type SmokeBrowser = {
  newPage: () => Promise<SmokePage>
  close: () => Promise<void>
}

type SmokePlaywright = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<SmokeBrowser>
  }
}

const SMOKE_TIMEOUT_MS = Number(process.env.SWIFT_RUNTIME_SMOKE_TIMEOUT_MS || 45_000)
const ROUTE_TIMEOUT_MS = Number(process.env.SWIFT_RUNTIME_ROUTE_TIMEOUT_MS || 12_000)
const MAX_ROUTE_CHECKS = Number(process.env.SWIFT_RUNTIME_MAX_ROUTE_CHECKS || 8)
const HYDRATION_RE = /hydration|text content did not match|initial ui does not match|server rendered html/i

export async function verifyRuntimeSmoke(input: {
  previewUrl: string
  files: GeneratedFile[]
  signal?: AbortSignal
}): Promise<RuntimeSmokeResult> {
  const startedAt = Date.now()
  const checks: RuntimeSmokeCheck[] = []
  const routes = inferStaticRoutes(input.files).slice(0, MAX_ROUTE_CHECKS)
  const apiRoutes = inferApiRoutes(input.files).slice(0, MAX_ROUTE_CHECKS)

  const record = (check: Omit<RuntimeSmokeCheck, "durationMs"> & { startedAt: number }) => {
    checks.push({
      ...check,
      durationMs: Date.now() - check.startedAt,
    })
  }

  try {
    let checkStartedAt = Date.now()
    const ready = await waitForHttp(input.previewUrl, input.signal)
    record({
      name: "runtime.server_ready",
      status: ready.ok ? "passed" : "failed",
      category: ready.ok ? undefined : "server_unreachable",
      message: ready.ok ? undefined : ready.error,
      startedAt: checkStartedAt,
    })
    if (!ready.ok) return failedResult(startedAt, checks, routes, apiRoutes, "server_unreachable", ready.error)

    const playwright = await loadPlaywright()
    if (!playwright) {
      const message = "Playwright is required for runtime verification but is not installed."
      checks.push({
        name: "runtime.playwright_available",
        status: "failed",
        durationMs: 0,
        category: "playwright_unavailable",
        message,
      })
      return failedResult(startedAt, checks, routes, apiRoutes, "playwright_unavailable", message)
    }

    checkStartedAt = Date.now()
    checks.push({
      name: "runtime.playwright_available",
      status: "passed",
      durationMs: 0,
    })

    const browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    })

    try {
      const page = await browser.newPage()
      const runtimeErrors: Array<{ type: RuntimeFailureCategory; message: string; url?: string }> = []
      page.on("console", (message: unknown) => {
        const item = message as { type?: () => string; text?: () => string }
        const type = typeof item.type === "function" ? item.type() : ""
        const text = typeof item.text === "function" ? item.text() : ""
        if (type === "error") {
          runtimeErrors.push({
            type: HYDRATION_RE.test(text) ? "hydration_error" : "console_error",
            message: text,
          })
        }
      })
      page.on("pageerror", (error: unknown) => {
        runtimeErrors.push({
          type: "unhandled_exception",
          message: error instanceof Error ? error.message : String(error),
        })
      })

      for (const route of routes) {
        checkStartedAt = Date.now()
        runtimeErrors.length = 0
        const url = new URL(route, input.previewUrl).toString()
        try {
          const response = await page.goto(url, { waitUntil: "networkidle", timeout: ROUTE_TIMEOUT_MS })
          const status = response?.status() || 0
          const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")
          const failedRuntime = runtimeErrors[0]
          if (!response || status >= 500 || !bodyText.trim()) {
            record({
              name: route === "/" ? "runtime.homepage_render" : "runtime.route_render",
              status: "failed",
              category: route === "/" ? "homepage_render_failed" : "route_render_failed",
              message: `Route ${route} failed to render with status ${status || "unknown"}.`,
              data: { route, status, bodyLength: bodyText.length },
              startedAt: checkStartedAt,
            })
            continue
          }

          if (failedRuntime) {
            record({
              name: route === "/" ? "runtime.homepage_render" : "runtime.route_render",
              status: "failed",
              category: failedRuntime.type,
              message: failedRuntime.message,
              data: { route, status },
              startedAt: checkStartedAt,
            })
            continue
          }

          record({
            name: route === "/" ? "runtime.homepage_render" : "runtime.route_render",
            status: "passed",
            data: { route, status, bodyLength: bodyText.length },
            startedAt: checkStartedAt,
          })
        } catch (error) {
          record({
            name: route === "/" ? "runtime.homepage_render" : "runtime.route_render",
            status: "failed",
            category: error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "route_render_failed",
            message: error instanceof Error ? error.message : String(error),
            data: { route },
            startedAt: checkStartedAt,
          })
        }
      }

      checkStartedAt = Date.now()
      const navigation = await verifyBrowserNavigation(page, input.previewUrl, routes)
      record({
        name: "runtime.browser_navigation",
        status: navigation.ok ? "passed" : "failed",
        category: navigation.ok ? undefined : "navigation_failed",
        message: navigation.error,
        data: navigation.data,
        startedAt: checkStartedAt,
      })
    } finally {
      await browser.close().catch(() => null)
    }

    for (const apiRoute of apiRoutes) {
      checkStartedAt = Date.now()
      const url = new URL(apiRoute, input.previewUrl).toString()
      try {
        const response = await fetch(url, { method: "GET", signal: input.signal })
        record({
          name: "runtime.api_route",
          status: response.status >= 500 ? "failed" : "passed",
          category: response.status >= 500 ? "api_route_failed" : undefined,
          message: response.status >= 500 ? `API route ${apiRoute} returned ${response.status}.` : undefined,
          data: { route: apiRoute, status: response.status },
          startedAt: checkStartedAt,
        })
      } catch (error) {
        record({
          name: "runtime.api_route",
          status: "failed",
          category: error instanceof Error && /timeout|aborted/i.test(error.message) ? "timeout" : "api_route_failed",
          message: error instanceof Error ? error.message : String(error),
          data: { route: apiRoute },
          startedAt: checkStartedAt,
        })
      }
    }
  } catch (error) {
    const category: RuntimeFailureCategory = error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "unhandled_exception"
    checks.push({
      name: "runtime.smoke_runner",
      status: "failed",
      durationMs: Date.now() - startedAt,
      category,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const failed = checks.find((check) => check.status === "failed")
  return {
    ok: !failed,
    durationMs: Date.now() - startedAt,
    checks,
    failureCategory: failed?.category,
    error: failed?.message,
    routes,
    apiRoutes,
  }
}

async function loadPlaywright(): Promise<SmokePlaywright | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>
    return await dynamicImport("playwright") as SmokePlaywright
  } catch {
    return null
  }
}

async function waitForHttp(url: string, signal?: AbortSignal) {
  const startedAt = Date.now()
  let lastError = ""
  while (Date.now() - startedAt < SMOKE_TIMEOUT_MS) {
    if (signal?.aborted) {
      return { ok: false, error: "Runtime verification aborted." }
    }

    try {
      const response = await fetch(url, { method: "GET", signal })
      if (response.status < 500) {
        return { ok: true }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return {
    ok: false,
    error: `Runtime did not become reachable within ${SMOKE_TIMEOUT_MS}ms. Last error: ${lastError}`,
  }
}

async function verifyBrowserNavigation(page: SmokePage, previewUrl: string, routes: string[]) {
  const secondRoute = routes.find((route) => route !== "/")
  if (!secondRoute) {
    return { ok: true, data: { skipped: true, reason: "No secondary static route available." } }
  }

  try {
    await page.goto(new URL("/", previewUrl).toString(), { waitUntil: "networkidle", timeout: ROUTE_TIMEOUT_MS })
    await page.evaluate((route: string) => {
      window.history.pushState({}, "", route)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, secondRoute)
    await page.waitForTimeout(250)
    return {
      ok: page.url().endsWith(secondRoute),
      data: { route: secondRoute, currentUrl: page.url() },
      error: page.url().endsWith(secondRoute) ? undefined : `Browser URL did not update to ${secondRoute}.`,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: { route: secondRoute },
    }
  }
}

function inferStaticRoutes(files: GeneratedFile[]) {
  const routes = new Set<string>(["/"])
  for (const file of files) {
    const route = routePathForPage(file.path)
    if (route) routes.add(route)
  }
  return Array.from(routes).sort((left, right) => left.localeCompare(right))
}

function inferApiRoutes(files: GeneratedFile[]) {
  const routes = new Set<string>()
  for (const file of files) {
    if (!/export\s+async\s+function\s+GET\s*\(/.test(file.content)) continue
    const route = routePathForApi(file.path)
    if (route) routes.add(route)
  }
  return Array.from(routes).sort((left, right) => left.localeCompare(right))
}

function routePathForPage(filePath: string) {
  const normalized = normalizePath(filePath)
  const match = normalized.match(/^app\/(.+\/)?page\.(tsx|ts|jsx|js)$/i)
  if (!match) return null
  const parts = (match[1] || "")
    .split("/")
    .filter(Boolean)
    .filter((part) => !part.startsWith("(") && !part.startsWith("@"))
  if (parts.some((part) => part.includes("[") || part.includes("]"))) return null
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/"
}

function routePathForApi(filePath: string) {
  const normalized = normalizePath(filePath)
  const match = normalized.match(/^app\/api\/(.+)\/route\.(ts|js)$/i)
  if (!match) return null
  if (match[1].includes("[") || match[1].includes("]")) return null
  return `/api/${match[1]}`
}

function failedResult(
  startedAt: number,
  checks: RuntimeSmokeCheck[],
  routes: string[],
  apiRoutes: string[],
  category: RuntimeFailureCategory,
  error?: string
): RuntimeSmokeResult {
  return {
    ok: false,
    durationMs: Date.now() - startedAt,
    checks,
    failureCategory: category,
    error,
    routes,
    apiRoutes,
  }
}

function normalizePath(value: string) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}
