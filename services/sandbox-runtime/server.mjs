import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import http from "node:http"
import express from "express"
import { WebSocketServer } from "ws"
import { createProxyMiddleware } from "http-proxy-middleware"
import { createProcessDriver } from "./process-driver.mjs"

const app = express()
app.use(express.json({ limit: process.env.SANDBOX_PAYLOAD_LIMIT || "8mb" }))
const processDriver = createProcessDriver()

const ROOT_DIR =
  process.env.SWIFT_SANDBOX_ROOT ||
  path.join(tmpdir(), "swift-sandboxes")
const BASE_PORT = Number(process.env.SWIFT_SANDBOX_BASE_PORT || 4300)
const MAX_LOG_LINES = Number(process.env.SWIFT_SANDBOX_MAX_LOG_LINES || 600)
const SERVICE_TOKEN = process.env.SANDBOX_SERVICE_TOKEN || ""
const IS_PRODUCTION = process.env.NODE_ENV === "production"
const WORKER_HEALTH_PROXY_URL = process.env.SWIFT_WORKER_HEALTH_PROXY_URL || "http://127.0.0.1:4000/health"
const MAX_PROJECTS = Number(process.env.SWIFT_SANDBOX_MAX_PROJECTS || 12)
const MAX_FILES = Number(process.env.SWIFT_SANDBOX_MAX_FILES || 240)
const MAX_TOTAL_BYTES = Number(process.env.SWIFT_SANDBOX_MAX_TOTAL_BYTES || 6 * 1024 * 1024)
const MAX_FILE_BYTES = Number(process.env.SWIFT_SANDBOX_MAX_FILE_BYTES || 512 * 1024)
const MIN_FREE_BYTES = envByteLimit("SWIFT_SANDBOX_MIN_FREE_BYTES", 256 * 1024 * 1024)
const MIN_INSTALL_FREE_BYTES = envByteLimit("SWIFT_SANDBOX_INSTALL_MIN_FREE_BYTES", MIN_FREE_BYTES)
const MIN_BUILD_FREE_BYTES = envByteLimit("SWIFT_SANDBOX_BUILD_MIN_FREE_BYTES", MIN_FREE_BYTES)
const PROJECT_IDLE_TTL_MS = Number(process.env.SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS || 30 * 60 * 1000)
const PROCESS_MAX_UPTIME_MS = Number(process.env.SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS || 20 * 60 * 1000)
const CLEANUP_INTERVAL_MS = Number(process.env.SWIFT_SANDBOX_CLEANUP_INTERVAL_MS || 60 * 1000)
// Replit-mode: Allow full multi-language project roots and files
const BLOCKED_EXACT_FILES = new Set([".git", "node_modules"])
const states = new Map()
const sandboxDatabaseUrl = () =>
  process.env.SWIFT_SANDBOX_DATABASE_URL || ""

console.log({
  nodeEnv: process.env.NODE_ENV,
  hasSandboxToken: !!process.env.SANDBOX_SERVICE_TOKEN,
  sandboxUrl: process.env.SANDBOX_SERVICE_URL,
})

if (IS_PRODUCTION && !SERVICE_TOKEN) {
  throw new Error("SANDBOX_SERVICE_TOKEN is required in production")
}

function envByteLimit(name, fallback) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown"
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}GB`
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10}KB`
  return `${bytes}B`
}

function isNoSpaceError(error) {
  const code = error && typeof error === "object" ? String(error.code || "") : ""
  const message = error instanceof Error ? error.message : String(error || "")
  return code === "ENOSPC" || /no space left on device|ENOSPC|Sandbox storage exhausted/i.test(message)
}

function normalizeSandboxError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Sandbox storage exhausted/i.test(message)) {
    return message
  }
  if (!isNoSpaceError(error)) {
    return message
  }

  return [
    "Sandbox storage exhausted: no space left on device while preparing runtime files or dependencies.",
    "Free space on SWIFT_SANDBOX_ROOT or move it to a larger volume.",
  ].join(" ")
}

function sourceBytes(files) {
  return files.reduce((sum, file) => sum + Buffer.byteLength(String(file.content || ""), "utf8"), 0)
}

async function readStorageHealth(rootDir = ROOT_DIR) {
  await mkdir(rootDir, { recursive: true })
  const storage = await statfs(rootDir)
  const availableBytes = Number(storage.bavail) * Number(storage.bsize)
  const totalBytes = Number(storage.blocks) * Number(storage.bsize)

  return {
    availableBytes,
    totalBytes,
    minFreeBytes: MIN_FREE_BYTES,
    ok: availableBytes >= MIN_FREE_BYTES,
  }
}

async function assertStorageAvailable(rootDir, requiredBytes, phase) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return

  try {
    const storage = await readStorageHealth(rootDir)
    if (storage.availableBytes >= requiredBytes) return

    throw new Error(
      `Sandbox storage exhausted before ${phase}: available ${formatBytes(storage.availableBytes)}, required ${formatBytes(requiredBytes)}.`
    )
  } catch (error) {
    const code = error && typeof error === "object" ? String(error.code || "") : ""
    if (code === "ENOSYS" || code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") return
    throw error
  }
}

const DEFAULT_ALLOWED_PACKAGES = [
  "@hookform/resolvers",
  "@prisma/client",
  "@radix-ui/react-accordion",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-label",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toast",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-tooltip",
  "@supabase/supabase-js",
  "@tailwindcss/postcss",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "autoprefixer",
  "bcryptjs",
  "class-variance-authority",
  "clsx",
  "date-fns",
  "framer-motion",
  "lucide-react",
  "next",
  "postcss",
  "prisma",
  "react",
  "react-dom",
  "react-hook-form",
  "recharts",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "typescript",
  "zod",
]

const allowedPackages = new Set([
  ...DEFAULT_ALLOWED_PACKAGES,
  ...String(process.env.SWIFT_SANDBOX_ALLOWED_PACKAGES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
])

function requireAuth(req, res, next) {
  if (!SERVICE_TOKEN) return next()
  const expected = `Bearer ${SERVICE_TOKEN}`
  if (req.get("authorization") !== expected) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  return next()
}

function sandboxProcessEnv(port, publicBase, customEnv = {}) {
  return {
    PATH: process.env.PATH || "",
    Path: process.env.Path || process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "",
    ComSpec: process.env.ComSpec || "",
    HOME: process.env.HOME || "",
    USERPROFILE: process.env.USERPROFILE || "",
    TEMP: process.env.TEMP || process.env.TMP || "",
    TMP: process.env.TMP || process.env.TEMP || "",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    DATABASE_URL: customEnv.DATABASE_URL || sandboxDatabaseUrl(),
    NEXTAUTH_SECRET: customEnv.NEXTAUTH_SECRET || process.env.SWIFT_SANDBOX_NEXTAUTH_SECRET || "swift-sandbox-local-secret",
    NEXTAUTH_URL: publicBase || `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL: publicBase || `http://127.0.0.1:${port}`,
    PORT: String(port),
    ...customEnv,
  }
}

function safeSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || randomUUID()
}

function normalizePath(filePath) {
  let normalized = String(filePath || "").trim().replace(/\\/g, "/")
  normalized = normalized.replace(/^\/+/, "")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized.replace(/\/{2,}/g, "/")
}

function stateFor(projectId) {
  const existing = states.get(projectId)
  if (existing) {
    existing.lastAccessAt = Date.now()
    return existing
  }

  if (states.size >= MAX_PROJECTS) {
    // Evict oldest idle project
    let oldestId = null
    let oldestAccess = Infinity
    for (const [id, s] of states.entries()) {
      if ((s.lastAccessAt || 0) < oldestAccess) {
        oldestAccess = s.lastAccessAt || 0
        oldestId = id
      }
    }
    if (oldestId) {
      const oldState = states.get(oldestId)
      if (oldState) {
        stopProcess(oldState).catch(() => null)
        states.delete(oldestId)
      }
    }
  }

  const numericHash = createHash("sha1").update(projectId).digest().readUInt32BE(0)
  const now = Date.now()
  const state = {
    projectId,
    rootDir: path.join(ROOT_DIR, safeSegment(projectId)),
    port: BASE_PORT + (numericHash % 1000),
    process: null,
    processStartedAt: null,
    logs: [],
    status: "idle",
    previewUrl: null,
    lastError: null,
    fileHash: null,
    packageHash: null,
    previewToken: randomUUID(),
    createdAt: now,
    lastAccessAt: now,
    env: {},
    runtimeType: "next",
  }
  states.set(projectId, state)
  return state
}

function appendLog(state, message) {
  const lines = String(message || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) return
  state.logs.push(...lines.map((line) => `[${new Date().toISOString()}] ${line}`))
  state.logs = state.logs.slice(-MAX_LOG_LINES)
}

function assertSafeFilePath(rootDir, filePath, options = {}) {
  const rawPath = String(filePath || "")
  const normalized = normalizePath(filePath)
  if (!normalized || normalized.includes("\0") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid file path: ${filePath}`)
  }

  if (/^[a-zA-Z]:[\\/]/.test(rawPath.trim())) {
    throw new Error(`Absolute sandbox file path rejected: ${filePath}`)
  }

  const segments = normalized.split("/")
  if (
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment === "~" ||
      segment.toLowerCase() === "node_modules" ||
      segment.toLowerCase() === ".git"
    )
  ) {
    throw new Error(`Blocked sandbox file path rejected: ${filePath}`)
  }

  const lower = normalized.toLowerCase()
  if (lower.includes("..") || lower.includes("~") || BLOCKED_EXACT_FILES.has(lower)) {
    throw new Error(`Blocked sandbox file path rejected: ${filePath}`)
  }

  const resolved = path.resolve(rootDir, normalized)
  const root = path.resolve(rootDir)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe sandbox file path rejected: ${filePath}`)
  }

  return { normalized, resolved }
}

function hashFiles(files) {
  const hash = createHash("sha256")
  for (const file of [...files].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    hash.update(normalizePath(file.path))
    hash.update("\0")
    hash.update(String(file.content || ""))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("No files provided.")
  }

  if (files.length > MAX_FILES) {
    throw new Error(`Too many files for sandbox preview. Maximum: ${MAX_FILES}`)
  }

  let totalBytes = 0
  for (const file of files) {
    assertSafeFilePath(ROOT_DIR, file.path, { allowManagedPackageJson: true })
    const size = Buffer.byteLength(String(file.content || ""), "utf8")
    if (size > MAX_FILE_BYTES) {
      throw new Error(`File ${file.path} exceeds sandbox file size limit.`)
    }
    totalBytes += size
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Sandbox payload exceeds total size limit. Maximum bytes: ${MAX_TOTAL_BYTES}`)
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function mergePackageJson(content) {
  const parsed = content ? JSON.parse(content) : {}
  const mergeDependencies = (...sources) => {
    return Object.assign({}, ...sources)
  }

  return {
    ...parsed,
    private: parsed.private !== undefined ? parsed.private : true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      "db:generate": "prisma generate",
      "db:push": "prisma db push",
      ...parsed.scripts,
    },
    dependencies: mergeDependencies(
      {
        "@prisma/client": "^5.22.0",
        "@supabase/supabase-js": "^2.104.0",
        "class-variance-authority": "^0.7.1",
        clsx: "^2.1.1",
        "lucide-react": "^0.564.0",
        next: "^16.2.6",
        react: "^19.2.5",
        "react-dom": "^19.2.5",
        "tailwind-merge": "^3.3.1",
        zod: "^3.24.1",
      },
      parsed.dependencies || {}
    ),
    devDependencies: mergeDependencies(
      {
        "@tailwindcss/postcss": "^4.2.0",
        "@types/node": "^22",
        "@types/react": "19.2.14",
        "@types/react-dom": "19.2.3",
        prisma: "^5.22.0",
        tailwindcss: "^4.2.0",
        typescript: "5.7.3",
      },
      parsed.devDependencies || {}
    ),
  }
}

async function ensureFiles(state, files, customEnv = {}) {
  await mkdir(state.rootDir, { recursive: true })
  await assertStorageAvailable(
    state.rootDir,
    Math.max(MIN_FREE_BYTES, sourceBytes(files) * 2),
    "writing generated files"
  )

  const isNextProject = files.some((f) => {
    const p = normalizePath(f.path)
    return p.startsWith("app/") || p.startsWith("src/") || (p === "package.json" && String(f.content).includes('"next"'))
  })

  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  if (packageFile || isNextProject) {
    const packageJson = mergePackageJson(packageFile?.content || null)
    await writeFile(path.join(state.rootDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

    const rootPackageLockPath = path.join(process.cwd(), "package-lock.json")
    if (await fileExists(rootPackageLockPath)) {
      const lockContent = await readFile(rootPackageLockPath, "utf8")
      await writeFile(path.join(state.rootDir, "package-lock.json"), lockContent, "utf8")
    }

    if (!(await fileExists(path.join(state.rootDir, "next.config.js"))) && isNextProject) {
      await writeFile(
        path.join(state.rootDir, "next.config.js"),
        [
          'const path = require("node:path")',
          "",
          "/** @type {import('next').NextConfig} */",
          "module.exports = {",
          "  turbopack: {",
          "    root: path.resolve(__dirname),",
          "  },",
          "}",
          "",
        ].join("\n"),
        "utf8"
      )
    }

    if (!(await fileExists(path.join(state.rootDir, "tsconfig.json"))) && isNextProject) {
      await writeFile(
        path.join(state.rootDir, "tsconfig.json"),
        `${JSON.stringify({
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            paths: {
              "@/*": ["./src/*", "./*"],
              "~/*": ["./src/*", "./*"],
            },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        }, null, 2)}\n`,
        "utf8"
      )
    }
  }

  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (normalized === "package.json" && (packageFile || isNextProject)) continue
    const { resolved } = assertSafeFilePath(state.rootDir, normalized)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, String(file.content || ""), "utf8")
  }

  // Inject secrets into .env and .env.local
  if (customEnv && typeof customEnv === "object" && Object.keys(customEnv).length > 0) {
    const envLines = Object.entries(customEnv).map(([k, v]) => `${k}=${v}`).join("\n")
    await writeFile(path.join(state.rootDir, ".env"), `${envLines}\n`, "utf8")
    await writeFile(path.join(state.rootDir, ".env.local"), `${envLines}\n`, "utf8")
  }

  if (isNextProject) {
    const appPagePath = path.join(state.rootDir, "app", "page.tsx")
    const srcPagePath = path.join(state.rootDir, "src", "app", "page.tsx")
    if (!(await fileExists(appPagePath)) && !(await fileExists(srcPagePath))) {
      await mkdir(path.dirname(appPagePath), { recursive: true })
      await writeFile(appPagePath, "export default function Page() { return <main style={{padding: 24}}>Swift runtime project is empty.</main> }\n", "utf8")
    }
  }
}

function runCommand(state, command, args, timeoutMs) {
  appendLog(state, `$ ${command} ${args.join(" ")}`)
  return new Promise((resolve) => {
    const child = processDriver.spawn(state, command, args, {
      env: sandboxProcessEnv(state.port, undefined, state.env || {}),
      role: "task",
    })

    let output = ""
    const timer = setTimeout(() => {
      appendLog(state, `Command timed out after ${Math.round(timeoutMs / 1000)}s`)
      processDriver.terminate(child)
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      const text = String(chunk)
      output += text
      appendLog(state, text)
    })
    child.stderr.on("data", (chunk) => {
      const text = String(chunk)
      output += text
      appendLog(state, text)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      appendLog(state, `Failed to start ${command}: ${error.message}`)
      resolve({ code: 1, output })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

async function stopProcess(state) {
  if (!state.process || state.process.killed) return
  appendLog(state, "Stopping previous dev server")
  processDriver.terminate(state.process)
  state.process = null
  state.processStartedAt = null
}

async function destroyState(projectId, state, reason) {
  appendLog(state, `Cleaning sandbox: ${reason}`)
  await stopProcess(state)
  await rm(state.rootDir, { recursive: true, force: true })
  states.delete(projectId)
}

setInterval(() => {
  const now = Date.now()
  for (const [projectId, state] of states.entries()) {
    const idleFor = now - (state.lastAccessAt || state.createdAt || now)
    const processAge = state.processStartedAt ? now - state.processStartedAt : 0
    if (idleFor > PROJECT_IDLE_TTL_MS || processAge > PROCESS_MAX_UPTIME_MS + 10_000) {
      void destroyState(projectId, state, "ttl-expired").catch((error) => {
        console.error("[sandbox-cleanup]", error)
      })
    }
  }
}, CLEANUP_INTERVAL_MS).unref?.()

function getSafeHeader(req, name) {
  if (!req) return ""
  if (typeof req.get === "function") return req.get(name) || ""
  return req.headers?.[name.toLowerCase()] || ""
}

function publicBaseUrl(req) {
  const configured = process.env.SANDBOX_PUBLIC_BASE_URL?.replace(/\/+$/, "")
  if (configured) return configured
  const proto = getSafeHeader(req, "x-forwarded-proto") || req.protocol || "http"
  const host = getSafeHeader(req, "host") || "127.0.0.1:8080"
  return `${proto}://${host}`
}

function getCookie(req, name) {
  const cookieHeader = getSafeHeader(req, "cookie")
  const parts = cookieHeader.split(";").map((part) => part.trim())
  for (const part of parts) {
    const index = part.indexOf("=")
    if (index <= 0) continue
    if (part.slice(0, index) === name) {
      return decodeURIComponent(part.slice(index + 1))
    }
  }
  return ""
}

async function detectProjectRuntime(rootDir) {
  if (
    (await fileExists(path.join(rootDir, "main.py"))) ||
    (await fileExists(path.join(rootDir, "app.py"))) ||
    (await fileExists(path.join(rootDir, "requirements.txt")))
  ) {
    const entry = (await fileExists(path.join(rootDir, "main.py")))
      ? "main.py"
      : (await fileExists(path.join(rootDir, "app.py")))
      ? "app.py"
      : null
    return { type: "python", entry }
  }
  if (await fileExists(path.join(rootDir, "package.json"))) {
    try {
      const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"))
      if (pkg.dependencies?.next || pkg.devDependencies?.next) {
        return { type: "next" }
      }
      if (pkg.scripts?.dev) {
        return { type: "node-npm", script: "dev" }
      }
      if (pkg.scripts?.start) {
        return { type: "node-npm", script: "start" }
      }
      if (await fileExists(path.join(rootDir, "index.js"))) {
        return { type: "node-file", entry: "index.js" }
      }
      if (await fileExists(path.join(rootDir, "server.js"))) {
        return { type: "node-file", entry: "server.js" }
      }
    } catch {}
    return { type: "next" }
  }
  if (await fileExists(path.join(rootDir, "index.html"))) {
    return { type: "static" }
  }
  return { type: "next" }
}

async function startDevServer(state, req) {
  if (state.process && !state.process.killed) return

  const runtime = await detectProjectRuntime(state.rootDir)
  state.runtimeType = runtime.type

  let command = "npm"
  let devArgs = ["run", "dev", "--", "--hostname", processDriver.devHostname, "--port", String(state.port)]

  if (runtime.type === "python") {
    command = "python"
    devArgs = runtime.entry ? [runtime.entry] : ["-m", "http.server", String(state.port)]
  } else if (runtime.type === "node-npm") {
    command = "npm"
    devArgs = ["run", runtime.script, "--", "--port", String(state.port)]
  } else if (runtime.type === "node-file") {
    command = "node"
    devArgs = [runtime.entry]
  } else if (runtime.type === "static") {
    command = "npx"
    devArgs = ["serve", ".", "-l", String(state.port)]
  }

  const child = processDriver.spawn(state, command, devArgs, {
    env: sandboxProcessEnv(
      state.port,
      `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}`,
      state.env || {}
    ),
    role: "dev",
    publishPort: state.port,
  })

  state.process = child
  state.processStartedAt = Date.now()
  state.previewUrl = `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}/?previewToken=${encodeURIComponent(state.previewToken)}`
  state.status = "running"
  appendLog(state, `$ ${command} ${devArgs.join(" ")} (runtime=${runtime.type}, driver=${processDriver.name})`)

  setTimeout(() => {
    if (state.process === child && !child.killed) {
      appendLog(state, `Stopping dev server after max uptime ${Math.round(PROCESS_MAX_UPTIME_MS / 1000)}s`)
      processDriver.terminate(child)
    }
  }, PROCESS_MAX_UPTIME_MS).unref?.()

  child.on("error", (error) => {
    appendLog(state, `Failed to start server: ${error.message}`)
  })

  child.stdout.on("data", (chunk) => appendLog(state, String(chunk)))
  child.stderr.on("data", (chunk) => appendLog(state, String(chunk)))
  child.on("close", (code) => {
    appendLog(state, `Server exited with code ${code ?? 1}`)
    if (state.process === child) {
      state.process = null
      state.processStartedAt = null
      if (state.status === "running") {
        state.status = "error"
        state.lastError = `Server exited with code ${code ?? 1}`
      }
    }
  })
}

async function startSandbox(projectId, files, req, customEnv = {}) {
  const state = stateFor(projectId)
  state.env = { ...(state.env || {}), ...(customEnv || {}) }
  const nextHash = hashFiles(files) + JSON.stringify(state.env)
  state.lastError = null

  try {
    appendLog(state, `Preparing sandbox for ${projectId}`)

    // Enforce SINGLE ACTIVE SANDBOX mode to stay within 1 vCPU / 1 GB RAM quota
    for (const [otherId, otherState] of states.entries()) {
      if (otherId !== projectId && otherState.process) {
        appendLog(otherState, `Stopping sandbox process to enforce single active sandbox for ${projectId}`)
        await stopProcess(otherState).catch(() => null)
        otherState.status = "idle"
        otherState.previewUrl = null
      }
    }
    if (state.fileHash !== nextHash) {
      await stopProcess(state)
      await ensureFiles(state, files, state.env)
      state.fileHash = nextHash
    }

    const runtime = await detectProjectRuntime(state.rootDir)
    if (runtime.type === "next" || runtime.type === "node-npm") {
      const packageContent = await readFile(path.join(state.rootDir, "package.json"), "utf8")
      const packageHash = createHash("sha256").update(packageContent).digest("hex")
      if (state.packageHash !== packageHash || !(await fileExists(path.join(state.rootDir, "node_modules")))) {
        state.status = "installing"
        await assertStorageAvailable(state.rootDir, MIN_INSTALL_FREE_BYTES, "installing dependencies")
        let install = await runCommand(state, "npm", ["ci", "--ignore-scripts"], Number(process.env.SWIFT_SANDBOX_INSTALL_TIMEOUT_MS || 120000))
        if (install.code !== 0) {
          appendLog(state, "npm ci failed, falling back to npm install for custom packages...")
          install = await runCommand(state, "npm", ["install", "--ignore-scripts"], Number(process.env.SWIFT_SANDBOX_INSTALL_TIMEOUT_MS || 120000))
        }
        if (install.code !== 0) throw new Error("npm install failed")
        state.packageHash = packageHash
      }

      if (runtime.type === "next") {
        state.status = "building"
        await assertStorageAvailable(state.rootDir, MIN_BUILD_FREE_BYTES, "building preview")
        const build = await runCommand(state, "npm", ["run", "build"], Number(process.env.SWIFT_SANDBOX_BUILD_TIMEOUT_MS || 150000))
        if (build.code !== 0) throw new Error("npm run build failed")
      }
    } else if (runtime.type === "python") {
      if (await fileExists(path.join(state.rootDir, "requirements.txt"))) {
        state.status = "installing"
        await runCommand(state, "pip", ["install", "-r", "requirements.txt"], 60000)
      }
    }

    await startDevServer(state, req)
    return state
  } catch (error) {
    state.status = "error"
    state.lastError = normalizeSandboxError(error)
    appendLog(state, `Sandbox error: ${state.lastError}`)
    return state
  }
}

function serialize(state) {
  return {
    status: state.status,
    previewUrl: state.previewUrl,
    logs: state.logs,
    error: state.lastError,
  }
}

app.get("/health", async (_req, res) => {
  let storageOk = true
  let storageError = null
  let storage = null
  try {
    storage = await readStorageHealth(ROOT_DIR)
    storageOk = storage.ok
    storageError = storage.ok
      ? null
      : `Sandbox storage low: available ${formatBytes(storage.availableBytes)}, required ${formatBytes(storage.minFreeBytes)}.`
  } catch (error) {
    storageOk = false
    storageError = error.message || String(error)
  }

  res.status(storageOk ? 200 : 503).json({
    status: storageOk ? "healthy" : "degraded",
    ok: storageOk,
    service: "swift-sandbox-runtime",
    checkedAt: new Date().toISOString(),
    runtime: {
      host: HOST,
      port: PORT,
      nodeEnv: process.env.NODE_ENV || "development",
      rootReady: storageOk,
      rootError: storageError,
      storage,
    },
    sandbox: {
      activeProjects: states.size,
      maxProjects: MAX_PROJECTS,
      rootReady: storageOk,
      rootError: storageError,
      storage,
      basePort: BASE_PORT,
      maxFiles: MAX_FILES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      hasDatabaseUrl: Boolean(sandboxDatabaseUrl()),
      isolation: processDriver.describe(),
    },
  })
})

app.get("/worker/health", async (_req, res) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SWIFT_WORKER_HEALTH_PROXY_TIMEOUT_MS || 5000))
  const startedAt = Date.now()

  try {
    const response = await fetch(WORKER_HEALTH_PROXY_URL, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    })
    const body = await response.json().catch(() => ({}))
    const queue = body && typeof body === "object" && body.queue && typeof body.queue === "object"
      ? body.queue
      : null
    const worker = body && typeof body === "object" && body.worker && typeof body.worker === "object"
      ? body.worker
      : null
    const healthy = response.ok && body?.status === "healthy" && body?.mode === "queue"

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "healthy" : String(body?.status || "unhealthy"),
      ok: healthy,
      mode: "queue",
      worker: worker?.healthy === false ? "unhealthy" : worker?.ready === false ? "starting" : healthy ? "healthy" : "degraded",
      queue: queue?.status || "unknown",
      heartbeat: queue?.workerHeartbeat
        ? {
            workerId: queue.workerHeartbeat.workerId || null,
            ageMs: queue.workerHeartbeat.ageMs ?? null,
            issues: Array.isArray(queue.workerHeartbeat.issues) ? queue.workerHeartbeat.issues : [],
          }
        : null,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      ok: false,
      mode: "queue",
      worker: "unreachable",
      queue: "unknown",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timeout)
  }
})

app.get("/sandbox/:projectId", requireAuth, (req, res) => {
  try {
    res.json(serialize(stateFor(req.params.projectId)))
  } catch (error) {
    res.status(503).json({ status: "error", previewUrl: null, logs: [], error: error.message || String(error) })
  }
})

app.post("/sandbox/:projectId", requireAuth, async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : []
    const env = req.body?.env && typeof req.body.env === "object" ? req.body.env : {}
    validateFiles(files)
    const state = await startSandbox(req.params.projectId, files, req, env)
    return res.status(state.lastError ? 500 : 200).json(serialize(state))
  } catch (error) {
    return res.status(400).json({
      status: "error",
      previewUrl: null,
      logs: [],
      error: error.message || String(error),
    })
  }
})

app.get("/sandbox/:projectId/terminal", requireAuth, (req, res) => {
  try {
    const state = stateFor(req.params.projectId)
    return res.json({
      projectId: req.params.projectId,
      status: state.status,
      driver: processDriver.name,
      runtimeType: state.runtimeType,
      previewUrl: state.previewUrl,
      wsEndpoint: `/terminals/${encodeURIComponent(req.params.projectId)}`,
    })
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) })
  }
})

app.post("/sandbox/:projectId/terminal/exec", requireAuth, async (req, res) => {
  try {
    const state = stateFor(req.params.projectId)
    const cmd = String(req.body?.command || "").trim()
    if (!cmd) {
      return res.status(400).json({ error: "Command required." })
    }
    const [execCmd, ...execArgs] = cmd.split(" ")
    const timeoutMs = Number(req.body?.timeoutMs || 45000)
    const result = await runCommand(state, execCmd, execArgs, timeoutMs)
    return res.json(result)
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) })
  }
})

app.delete("/sandbox/:projectId", requireAuth, async (req, res) => {
  try {
    const state = stateFor(req.params.projectId)
    await destroyState(req.params.projectId, state, "delete-request")
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || String(error) })
  }
})

app.use("/preview/:projectId", (req, res, next) => {
  const state = stateFor(req.params.projectId)
  if (!state.process || state.status !== "running") {
    return res.status(503).send("Sandbox preview is not running.")
  }

  const queryToken = typeof req.query.previewToken === "string" ? req.query.previewToken : ""
  const cookieToken = getCookie(req, `swift_preview_${safeSegment(req.params.projectId)}`)
  if (queryToken !== state.previewToken && cookieToken !== state.previewToken) {
    return res.status(403).send("Preview token is required.")
  }

  if (queryToken === state.previewToken) {
    res.cookie(`swift_preview_${safeSegment(req.params.projectId)}`, state.previewToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: PROJECT_IDLE_TTL_MS,
    })
  }

  return createProxyMiddleware({
    target: `http://127.0.0.1:${state.port}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: (_path, request) => {
      const prefix = `/preview/${encodeURIComponent(request.params.projectId)}`
      return request.originalUrl.replace(prefix, "") || "/"
    },
    on: {
      error: (_err, _req, res) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sandbox Mempersiapkan Runtime</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #09090b; color: #fafafa; text-align: center; }
    .card { max-width: 420px; padding: 24px; border: 1px solid #27272a; border-radius: 12px; background: #18181b; }
    h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
    p { margin: 0; font-size: 13px; color: #a1a1aa; line-height: 1.5; }
    .spinner { display: inline-block; width: 22px; height: 22px; border: 2px solid #3f3f46; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3>Sandbox Sedang Mempersiapkan Runtime...</h3>
    <p>Aplikasi sedang dikompilasi pada port internal. Halaman akan otomatis memuat ulang dalam 3 detik.</p>
  </div>
</body>
</html>`)
        }
      },
    },
  })(req, res, next)
})

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || "0.0.0.0"

if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`)
}

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`)
    const match = url.pathname.match(/^\/(?:terminals|terminal|api\/terminal|ws\/terminal)\/([^/?#]+)/)
    if (!match) {
      // Let other websocket upgrades pass to proxy
      return
    }

    const projectId = decodeURIComponent(match[1])
    const token = url.searchParams.get("token") || url.searchParams.get("previewToken") || ""
    const state = states.get(projectId) || stateFor(projectId)

    if (IS_PRODUCTION && SERVICE_TOKEN && token !== SERVICE_TOKEN && token !== state.previewToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, projectId)
    })
  } catch {
    socket.destroy()
  }
})

wss.on("connection", async (ws, req, projectId) => {
  const state = states.get(projectId) || stateFor(projectId)
  state.lastAccessAt = Date.now()
  await mkdir(state.rootDir, { recursive: true })

  let shellCmd = ""
  let shellArgs = []

  if (processDriver.name === "docker") {
    const devContainer = state.process?.containerName
    if (devContainer) {
      shellCmd = "docker"
      shellArgs = ["exec", "-i", "-e", "TERM=xterm-256color", "-w", "/workspace", devContainer, "/bin/sh"]
    } else {
      shellCmd = "docker"
      shellArgs = [
        "run",
        "-i",
        "--rm",
        "-w",
        "/workspace",
        "-v",
        `${state.rootDir}:/workspace`,
        "-e",
        "TERM=xterm-256color",
        "node:22-bookworm-slim",
        "/bin/sh",
      ]
    }
  } else {
    if (process.platform === "win32") {
      shellCmd = process.env.ComSpec || "cmd.exe"
      shellArgs = []
    } else {
      shellCmd = process.env.SHELL || "/bin/bash"
      shellArgs = ["-l"]
    }
  }

  const child = spawn(shellCmd, shellArgs, {
    cwd: state.rootDir,
    env: {
      ...process.env,
      ...sandboxProcessEnv(state.port, publicBaseUrl(req), state.env || {}),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    shell: false,
  })

  const banner = `\r\n\x1b[1;36m==============================================================\x1b[0m\r\n` +
    `  \x1b[1;32mSWIFT CLOUD TERMINAL (REPLIT ENGINE)\x1b[0m\r\n` +
    `  Project: \x1b[1;33m${projectId}\x1b[0m | Driver: \x1b[1;35m${processDriver.name}\x1b[0m\r\n` +
    `\x1b[1;36m==============================================================\x1b[0m\r\n\r\n`
  ws.send(banner)

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString())
      }
    })
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString())
      }
    })
  }

  ws.on("message", (msg) => {
    if (!child.stdin || child.stdin.destroyed) return
    const raw = msg.toString()
    try {
      if (raw.startsWith("{") && raw.endsWith("}")) {
        const payload = JSON.parse(raw)
        if (payload.type === "input" && typeof payload.data === "string") {
          child.stdin.write(payload.data)
          return
        }
        if (payload.type === "resize") {
          return
        }
      }
    } catch {}
    child.stdin.write(raw)
  })

  child.on("close", (code) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33m[Terminal process exited with code ${code ?? 0}]\x1b[0m\r\n`)
      ws.close()
    }
  })

  child.on("error", (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[31m[Terminal spawn error: ${err.message}]\x1b[0m\r\n`)
    }
  })

  ws.on("close", () => {
    if (!child.killed) {
      try {
        child.kill()
      } catch {}
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`swift-sandbox-runtime listening on ${HOST}:${PORT} (HTTP & WebSocket Terminal enabled)`)
})

