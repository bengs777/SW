import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import express from "express"
import { createProxyMiddleware } from "http-proxy-middleware"

const app = express()
app.use(express.json({ limit: process.env.SANDBOX_PAYLOAD_LIMIT || "8mb" }))

const ROOT_DIR =
  process.env.SWIFT_SANDBOX_ROOT ||
  path.join(tmpdir(), "swift-sandboxes")
const BASE_PORT = Number(process.env.SWIFT_SANDBOX_BASE_PORT || 4300)
const MAX_LOG_LINES = Number(process.env.SWIFT_SANDBOX_MAX_LOG_LINES || 600)
const SERVICE_TOKEN = process.env.SANDBOX_SERVICE_TOKEN || ""
const IS_PRODUCTION = process.env.NODE_ENV === "production"
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
const ALLOWED_GENERATED_ROOTS = ["src", "app", "components", "lib", "prisma"]
const SAFE_GENERATED_ROOT_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "readme.md",
  ".env.example",
])
const BLOCKED_EXACT_FILES = new Set([".env", ".git", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
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

function sandboxProcessEnv(port, publicBase) {
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
    DATABASE_URL: sandboxDatabaseUrl(),
    NEXTAUTH_SECRET: process.env.SWIFT_SANDBOX_NEXTAUTH_SECRET || "swift-sandbox-local-secret",
    NEXTAUTH_URL: publicBase || `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL: publicBase || `http://127.0.0.1:${port}`,
    PORT: String(port),
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
    throw new Error(`Sandbox capacity reached. Maximum active projects: ${MAX_PROJECTS}`)
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
  const blockedEnvPath = lower !== ".env.example" && lower.split("/").some((segment) => segment === ".env" || segment.startsWith(".env."))
  if (lower.includes("..") || lower.includes("~") || BLOCKED_EXACT_FILES.has(lower) || blockedEnvPath) {
    throw new Error(`Blocked sandbox file path rejected: ${filePath}`)
  }

  const allowedRoot = ALLOWED_GENERATED_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))
  const safeRootFile = SAFE_GENERATED_ROOT_FILES.has(lower)
  const managedPackageJson = options.allowManagedPackageJson === true && lower === "package.json"
  if (!allowedRoot && !safeRootFile && !managedPackageJson) {
    throw new Error(`Sandbox file path is outside allowed project roots: ${filePath}`)
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
    const merged = Object.assign({}, ...sources)

    return Object.fromEntries(
      Object.entries(merged).filter(([name]) => allowedPackages.has(name))
    )
  }

  return {
    ...parsed,
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      "db:generate": "prisma generate",
      "db:push": "prisma db push",
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

async function ensureFiles(state, files) {
  await mkdir(state.rootDir, { recursive: true })
  await assertStorageAvailable(
    state.rootDir,
    Math.max(MIN_FREE_BYTES, sourceBytes(files) * 2),
    "writing generated files"
  )

  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  const packageJson = mergePackageJson(packageFile?.content || null)
  await writeFile(path.join(state.rootDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

  const rootPackageLockPath = path.join(process.cwd(), "package-lock.json")
  if (await fileExists(rootPackageLockPath)) {
    const lockContent = await readFile(rootPackageLockPath, "utf8")
    await writeFile(path.join(state.rootDir, "package-lock.json"), lockContent, "utf8")
  }

  if (!(await fileExists(path.join(state.rootDir, "next.config.js")))) {
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

  if (!(await fileExists(path.join(state.rootDir, "tsconfig.json")))) {
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

  for (const file of files) {
    const normalized = normalizePath(file.path)
    if (normalized === "package.json") continue
    const { resolved } = assertSafeFilePath(state.rootDir, normalized)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, String(file.content || ""), "utf8")
  }

  const appPagePath = path.join(state.rootDir, "app", "page.tsx")
  if (!(await fileExists(appPagePath))) {
    await mkdir(path.dirname(appPagePath), { recursive: true })
    await writeFile(appPagePath, "export default function Page() { return <main style={{padding: 24}}>Swift runtime project is empty.</main> }\n", "utf8")
  }
}

function runCommand(state, command, args, timeoutMs) {
  appendLog(state, `$ ${command} ${args.join(" ")}`)
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: state.rootDir,
      env: sandboxProcessEnv(state.port),
      shell: false,
    })

    let output = ""
    const timer = setTimeout(() => {
      appendLog(state, `Command timed out after ${Math.round(timeoutMs / 1000)}s`)
      child.kill()
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
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

async function stopProcess(state) {
  if (!state.process || state.process.killed) return
  appendLog(state, "Stopping previous dev server")
  state.process.kill()
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

function publicBaseUrl(req) {
  const configured = process.env.SANDBOX_PUBLIC_BASE_URL?.replace(/\/+$/, "")
  if (configured) return configured
  const proto = req.get("x-forwarded-proto") || req.protocol || "https"
  return `${proto}://${req.get("host")}`
}

function getCookie(req, name) {
  const cookieHeader = req.get("cookie") || ""
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

function startDevServer(state, req) {
  if (state.process && !state.process.killed) return

  const child = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(state.port)], {
    cwd: state.rootDir,
    env: sandboxProcessEnv(
      state.port,
      `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}`
    ),
    shell: false,
  })

  state.process = child
  state.processStartedAt = Date.now()
  state.previewUrl = `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}/?previewToken=${encodeURIComponent(state.previewToken)}`
  state.status = "running"
  appendLog(state, `$ npm run dev -- --hostname 127.0.0.1 --port ${state.port}`)

  setTimeout(() => {
    if (state.process === child && !child.killed) {
      appendLog(state, `Stopping dev server after max uptime ${Math.round(PROCESS_MAX_UPTIME_MS / 1000)}s`)
      child.kill()
    }
  }, PROCESS_MAX_UPTIME_MS).unref?.()

  child.stdout.on("data", (chunk) => appendLog(state, String(chunk)))
  child.stderr.on("data", (chunk) => appendLog(state, String(chunk)))
  child.on("close", (code) => {
    appendLog(state, `Dev server exited with code ${code ?? 1}`)
    if (state.process === child) {
      state.process = null
      state.processStartedAt = null
      if (state.status === "running") {
        state.status = "error"
        state.lastError = `Dev server exited with code ${code ?? 1}`
      }
    }
  })
}

async function startSandbox(projectId, files, req) {
  const state = stateFor(projectId)
  const nextHash = hashFiles(files)
  state.lastError = null

  try {
    appendLog(state, `Preparing sandbox for ${projectId}`)
    if (state.fileHash !== nextHash) {
      await stopProcess(state)
      await ensureFiles(state, files)
      state.fileHash = nextHash
    }

    const packageContent = await readFile(path.join(state.rootDir, "package.json"), "utf8")
    const packageHash = createHash("sha256").update(packageContent).digest("hex")
    if (state.packageHash !== packageHash || !(await fileExists(path.join(state.rootDir, "node_modules")))) {
      state.status = "installing"
      await assertStorageAvailable(state.rootDir, MIN_INSTALL_FREE_BYTES, "installing dependencies")
      const install = await runCommand(state, "npm", ["ci", "--ignore-scripts"], Number(process.env.SWIFT_SANDBOX_INSTALL_TIMEOUT_MS || 120000))
      if (install.code !== 0) throw new Error("npm ci failed")
      state.packageHash = packageHash
    }

    state.status = "building"
    await assertStorageAvailable(state.rootDir, MIN_BUILD_FREE_BYTES, "building preview")
    const build = await runCommand(state, "npm", ["run", "build"], Number(process.env.SWIFT_SANDBOX_BUILD_TIMEOUT_MS || 150000))
    if (build.code !== 0) throw new Error("npm run build failed")

    startDevServer(state, req)
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
    },
  })
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
    validateFiles(files)
    const state = await startSandbox(req.params.projectId, files, req)
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
  })(req, res, next)
})

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || "0.0.0.0"

if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`)
}

app.listen(PORT, HOST, () => {
  console.log(`swift-sandbox-runtime listening on ${HOST}:${PORT}`)
})
