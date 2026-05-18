import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createHash } from "crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import type { GeneratedFile } from "@/lib/types"
import { verifyRuntimeSmoke, type RuntimeSmokeResult } from "@/lib/sandbox/runtime-smoke"

type SandboxState = {
  projectId: string
  rootDir: string
  port: number
  process: ChildProcessWithoutNullStreams | null
  logs: string[]
  status: "idle" | "installing" | "generating" | "typechecking" | "linting" | "building" | "verifying" | "running" | "error"
  previewUrl: string | null
  lastError: string | null
  fileHash: string | null
  packageHash: string | null
}

export type SandboxValidationStep = {
  name: "install" | "prisma-generate" | "typecheck" | "lint" | "build"
  status: "passed" | "failed" | "skipped"
  policy: "required" | "advisory"
  command?: string
  durationMs?: number
  output?: string
  reason?: string
}

type StartSandboxResult = {
  status: SandboxState["status"]
  previewUrl: string | null
  logs: string[]
  error: string | null
  validation: SandboxValidationStep[]
  runtimeVerification: RuntimeSmokeResult | null
}

const SANDBOX_ROOT =
  process.env.SWIFT_SANDBOX_ROOT ||
  path.join(process.env.VERCEL ? tmpdir() : process.cwd(), ".swift-sandboxes")
const BASE_PORT = Number(process.env.SWIFT_SANDBOX_BASE_PORT || 4300)
const MAX_LOG_LINES = 500
const RUNTIME_CONFIG_VERSION = "validation-v2"
const SANDBOX_MEMORY_MB = Math.max(128, Number(process.env.SWIFT_SANDBOX_MEMORY_MB || 768))
const MAX_SANDBOX_SOURCE_BYTES = Number(process.env.SWIFT_SANDBOX_SOURCE_BYTES || 8 * 1024 * 1024)
const MAX_SANDBOX_WORKSPACE_BYTES = Number(process.env.SWIFT_SANDBOX_WORKSPACE_BYTES || 160 * 1024 * 1024)
const sandboxDatabaseUrl = () =>
  process.env.SWIFT_SANDBOX_DATABASE_URL || ""

const ALLOWED_PACKAGES = new Set([
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
  "class-variance-authority",
  "clsx",
  "date-fns",
  "eslint",
  "eslint-config-next",
  "framer-motion",
  "lucide-react",
  "next",
  "next-auth",
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
])

const globalForSandbox = globalThis as unknown as {
  swiftSandboxStates?: Map<string, SandboxState>
  swiftSandboxLocks?: Map<string, Promise<void>>
}

const states = globalForSandbox.swiftSandboxStates ?? new Map<string, SandboxState>()
globalForSandbox.swiftSandboxStates = states
const sandboxLocks = globalForSandbox.swiftSandboxLocks ?? new Map<string, Promise<void>>()
globalForSandbox.swiftSandboxLocks = sandboxLocks

function getState(projectId: string): SandboxState {
  const existing = states.get(projectId)
  if (existing) return existing

  const numericHash = createHash("sha1").update(projectId).digest().readUInt32BE(0)
  const state: SandboxState = {
    projectId,
    rootDir: path.join(SANDBOX_ROOT, safeSegment(projectId)),
    port: BASE_PORT + (numericHash % 1000),
    process: null,
    logs: [],
    status: "idle",
    previewUrl: null,
    lastError: null,
    fileHash: null,
    packageHash: null,
  }

  states.set(projectId, state)
  return state
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "project"
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "")
}

function assertSafeFilePath(rootDir: string, filePath: string) {
  const normalized = normalizePath(filePath)
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`Invalid file path: ${filePath}`)
  }

  const resolved = path.resolve(rootDir, normalized)
  const root = path.resolve(rootDir)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe sandbox file path rejected: ${filePath}`)
  }

  if (/(^|\/)(node_modules|\.next|\.git|dist|build)(\/|$)/i.test(normalized)) {
    throw new Error(`Generated files cannot write into runtime output folders: ${filePath}`)
  }

  return { normalized, resolved }
}

function appendLog(state: SandboxState, message: string) {
  const lines = message
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) return
  state.logs.push(...lines.map((line) => `[${new Date().toISOString()}] ${line}`))
  state.logs = state.logs.slice(-MAX_LOG_LINES)
}

function hashFiles(files: GeneratedFile[]) {
  const hash = createHash("sha256")
  hash.update(RUNTIME_CONFIG_VERSION)
  hash.update("\0")
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(normalizePath(file.path))
    hash.update("\0")
    hash.update(file.content || "")
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function cleanSandboxRoot(state: SandboxState) {
  await mkdir(state.rootDir, { recursive: true })
  const entries = await readdir(state.rootDir, { withFileTypes: true })

  await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules")
      .map((entry) => rm(path.join(state.rootDir, entry.name), { recursive: entry.isDirectory(), force: true }))
  )
}

function commandName(command: string) {
  return process.platform === "win32" ? `${command}.cmd` : command
}

function sandboxNodeOptions() {
  const existing = process.env.NODE_OPTIONS || ""
  const withoutMemory = existing.replace(/--max-old-space-size=\S+/g, "").trim()
  return `${withoutMemory} --max-old-space-size=${SANDBOX_MEMORY_MB}`.trim()
}

function sandboxProcessEnv(port: number): NodeJS.ProcessEnv {
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
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: sandboxNodeOptions(),
    NODE_ENV: "production",
    DATABASE_URL: sandboxDatabaseUrl(),
    NEXTAUTH_SECRET: "swift-sandbox-local-secret",
    NEXTAUTH_URL: `http://localhost:${port}`,
    NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
    PORT: String(port),
  }
}

async function killProcessTree(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) return

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        shell: false,
        windowsHide: true,
      })
      killer.on("close", () => resolve())
      killer.on("error", () => resolve())
    })
    return
  }

  try {
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL")
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // Process already exited.
    }
  }
}

function runCommand(
  state: SandboxState,
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
) {
  appendLog(state, `$ ${command} ${args.join(" ")}`)

  return new Promise<{ code: number; output: string; durationMs: number; timedOut: boolean; aborted: boolean }>((resolve) => {
    const startedAt = Date.now()
    if (signal?.aborted) {
      resolve({ code: 1, output: "Command aborted before start", durationMs: 0, timedOut: false, aborted: true })
      return
    }

    const child = spawn(commandName(command), args, {
      cwd: state.rootDir,
      env: sandboxProcessEnv(state.port),
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      windowsHide: true,
    })

    let output = ""
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      appendLog(state, `Command timed out after ${Math.round(timeoutMs / 1000)}s`)
      void killProcessTree(child)
    }, timeoutMs)
    const abort = () => {
      aborted = true
      appendLog(state, "Command aborted")
      void killProcessTree(child)
    }
    signal?.addEventListener("abort", abort, { once: true })

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
      signal?.removeEventListener("abort", abort)
      resolve({
        code: code ?? 1,
        output,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
      })
    })
  })
}

function mergePackageJson(existingContent: string | null) {
  const base = {
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      "db:generate": "prisma generate",
      "db:push": "prisma db push",
    },
    dependencies: {
      "@prisma/client": "^5.22.0",
      "@supabase/supabase-js": "^2.104.0",
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
      "lucide-react": "^0.564.0",
      next: "^16.2.6",
      "next-auth": "^5.0.0-beta.20",
      react: "^19.2.5",
      "react-dom": "^19.2.5",
      "tailwind-merge": "^3.3.1",
      zod: "^3.24.1",
    },
    devDependencies: {
      "@tailwindcss/postcss": "^4.2.0",
      "@types/node": "^22",
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      eslint: "^9.39.4",
      "eslint-config-next": "^16.2.6",
      prisma: "^5.22.0",
      tailwindcss: "^4.2.0",
      typescript: "5.7.3",
    },
  }

  const parsed = existingContent ? JSON.parse(existingContent) : {}
  return {
    ...parsed,
    private: true,
    scripts: base.scripts,
    dependencies: filterAllowedDependencies({
      ...base.dependencies,
      ...(parsed.dependencies || {}),
    }),
    devDependencies: filterAllowedDependencies({
      ...base.devDependencies,
      ...(parsed.devDependencies || {}),
    }),
  }
}

function filterAllowedDependencies(dependencies: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(dependencies)
      .filter(([name, version]) => ALLOWED_PACKAGES.has(name) && typeof version === "string" && version.trim())
      .map(([name, version]) => [name, String(version)])
  )
}

function hasPackageScript(packageContent: string, scriptName: string) {
  try {
    const parsed = JSON.parse(packageContent) as { scripts?: Record<string, unknown> }
    return typeof parsed.scripts?.[scriptName] === "string" && parsed.scripts[scriptName].trim().length > 0
  } catch {
    return false
  }
}

function tailOutput(output: string, maxChars = 6000) {
  const normalized = String(output || "").trim()
  return normalized.length <= maxChars ? normalized : normalized.slice(-maxChars)
}

function commandFailureMessage(step: SandboxValidationStep) {
  const output = step.output ? `\n\n${step.output}` : ""
  const reason = step.reason ? ` (${step.reason})` : ""
  return `${step.name} failed${reason}${output}`
}

async function fileExists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureRuntimeFiles(state: SandboxState, files: GeneratedFile[]) {
  await mkdir(state.rootDir, { recursive: true })
  assertFilesystemQuota(files)

  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  const packageJson = mergePackageJson(packageFile?.content || null)
  await writeFile(
    path.join(state.rootDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8"
  )

  const rootPackageLockPath = path.join(process.cwd(), "package-lock.json")
  if (process.env.SWIFT_SANDBOX_COPY_ROOT_LOCK === "true" && await fileExists(rootPackageLockPath)) {
    const lockContent = await readFile(rootPackageLockPath, "utf8")
    await writeFile(path.join(state.rootDir, "package-lock.json"), lockContent, "utf8")
  }

  const nextConfigPath = path.join(state.rootDir, "next.config.js")
  if (!(await fileExists(nextConfigPath))) {
    await writeFile(nextConfigPath, "/** @type {import('next').NextConfig} */\nmodule.exports = {}\n", "utf8")
  }

  const eslintConfigPath = path.join(state.rootDir, "eslint.config.mjs")
  if (!(await fileExists(eslintConfigPath))) {
    await writeFile(
      eslintConfigPath,
      [
        'import { defineConfig, globalIgnores } from "eslint/config"',
        'import nextVitals from "eslint-config-next/core-web-vitals"',
        'import nextTs from "eslint-config-next/typescript"',
        "",
        "export default defineConfig([",
        "  ...nextVitals,",
        "  ...nextTs,",
        '  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),',
        "])",
        "",
      ].join("\n"),
      "utf8"
    )
  }

  const tsconfigPath = path.join(state.rootDir, "tsconfig.json")
  if (!(await fileExists(tsconfigPath))) {
    await writeFile(
      tsconfigPath,
      JSON.stringify(
        {
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
        },
        null,
        2
      ) + "\n",
      "utf8"
    )
  }

  const nextEnvPath = path.join(state.rootDir, "next-env.d.ts")
  if (!(await fileExists(nextEnvPath))) {
    await writeFile(
      nextEnvPath,
      [
        "/// <reference types=\"next\" />",
        "/// <reference types=\"next/image-types/global\" />",
        "",
        "// This file is generated by Swift runtime validation.",
        "",
      ].join("\n"),
      "utf8"
    )
  }

  const envPath = path.join(state.rootDir, ".env.local")
  if (!(await fileExists(envPath))) {
    await writeFile(
      envPath,
      [
        `DATABASE_URL=${sandboxDatabaseUrl()}`,
        `DIRECT_DATABASE_URL=${process.env.SWIFT_SANDBOX_DIRECT_DATABASE_URL || ""}`,
        "NEXTAUTH_SECRET=swift-sandbox-local-secret",
        `NEXTAUTH_URL=http://localhost:${state.port}`,
        `NEXT_PUBLIC_APP_URL=http://localhost:${state.port}`,
        "NEXT_PUBLIC_SUPABASE_URL=",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
      ].join("\n") + "\n",
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
    await writeFile(
      appPagePath,
      "export default function Page() { return <main style={{padding: 24}}>Swift runtime project is empty.</main> }\n",
      "utf8"
    )
  }
}

async function stopProcess(state: SandboxState) {
  if (!state.process || state.process.killed) return
  appendLog(state, "Stopping previous preview server")
  await killProcessTree(state.process)
  state.process = null
}

function startPreviewServer(state: SandboxState) {
  if (state.process && !state.process.killed) {
    return
  }

  const child = spawn(commandName("npm"), ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(state.port)], {
    cwd: state.rootDir,
    env: sandboxProcessEnv(state.port),
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    windowsHide: true,
  })

  state.process = child
  state.previewUrl = `http://127.0.0.1:${state.port}`
  state.status = "running"
  appendLog(state, `$ npm run start -- --hostname 127.0.0.1 --port ${state.port}`)

  child.stdout.on("data", (chunk) => appendLog(state, String(chunk)))
  child.stderr.on("data", (chunk) => appendLog(state, String(chunk)))
  child.on("close", (code) => {
    appendLog(state, `Dev server exited with code ${code ?? 1}`)
    if (state.process === child) {
      state.process = null
      if (state.status === "running") {
        state.status = "error"
        state.lastError = `Preview server exited with code ${code ?? 1}`
      }
    }
  })
}

export async function startRuntimeSandbox(projectId: string, files: GeneratedFile[], options?: { signal?: AbortSignal }): Promise<StartSandboxResult> {
  return withSandboxLock(projectId, () => startRuntimeSandboxUnlocked(projectId, files, options))
}

async function startRuntimeSandboxUnlocked(projectId: string, files: GeneratedFile[], options?: { signal?: AbortSignal }): Promise<StartSandboxResult> {
  const state = getState(projectId)
  const nextFileHash = hashFiles(files)
  const validation: SandboxValidationStep[] = []
  let runtimeVerification: RuntimeSmokeResult | null = null

  try {
    state.lastError = null
    appendLog(state, `Preparing runtime sandbox for project ${projectId}`)

    if (state.fileHash !== nextFileHash) {
      await stopProcess(state)
      await cleanSandboxRoot(state)
      await ensureRuntimeFiles(state, files)
      state.fileHash = nextFileHash
    }

    const packageContent = await readFile(path.join(state.rootDir, "package.json"), "utf8")
    const nextPackageHash = createHash("sha256").update(packageContent).digest("hex")
    if (state.packageHash !== nextPackageHash || !(await fileExists(path.join(state.rootDir, "node_modules")))) {
      state.status = "installing"
      const install = await runCommand(state, "npm", ["install", "--ignore-scripts"], 120_000, options?.signal)
      validation.push({
        name: "install",
        status: install.code === 0 ? "passed" : "failed",
        policy: "required",
        command: "npm install --ignore-scripts",
        durationMs: install.durationMs,
        output: install.code === 0 ? undefined : tailOutput(install.output),
        reason: install.timedOut ? "timeout" : install.aborted ? "aborted" : undefined,
      })
      if (options?.signal?.aborted) {
        throw new Error("GENERATION_JOB_CANCELLED")
      }
      if (install.code !== 0) {
        throw new Error(commandFailureMessage(validation[validation.length - 1]))
      }
      state.packageHash = nextPackageHash
    } else {
      validation.push({
        name: "install",
        status: "skipped",
        policy: "required",
        reason: "node_modules and package hash are unchanged",
      })
    }

    const hasPrismaSchema = files.some((file) => normalizePath(file.path) === "prisma/schema.prisma")
    if (hasPrismaSchema) {
      state.status = "generating"
      const prismaGenerate = await runCommand(state, "npm", ["run", "db:generate"], 90_000, options?.signal)
      validation.push({
        name: "prisma-generate",
        status: prismaGenerate.code === 0 ? "passed" : "failed",
        policy: "required",
        command: "npm run db:generate",
        durationMs: prismaGenerate.durationMs,
        output: prismaGenerate.code === 0 ? undefined : tailOutput(prismaGenerate.output),
        reason: prismaGenerate.timedOut ? "timeout" : prismaGenerate.aborted ? "aborted" : undefined,
      })
      if (options?.signal?.aborted) {
        throw new Error("GENERATION_JOB_CANCELLED")
      }
      if (prismaGenerate.code !== 0) {
        throw new Error(commandFailureMessage(validation[validation.length - 1]))
      }
    }

    state.status = "typechecking"
    const typecheck = await runCommand(state, "npm", ["run", "typecheck"], 90_000, options?.signal)
    validation.push({
      name: "typecheck",
      status: typecheck.code === 0 ? "passed" : "failed",
      policy: "required",
      command: "npm run typecheck",
      durationMs: typecheck.durationMs,
      output: typecheck.code === 0 ? undefined : tailOutput(typecheck.output),
      reason: typecheck.timedOut ? "timeout" : typecheck.aborted ? "aborted" : undefined,
    })
    if (options?.signal?.aborted) {
      throw new Error("GENERATION_JOB_CANCELLED")
    }
    if (typecheck.code !== 0) {
      throw new Error(commandFailureMessage(validation[validation.length - 1]))
    }

    state.status = "linting"
    const packageHasLint = hasPackageScript(packageContent, "lint")
    const lintPolicy = process.env.SWIFT_SANDBOX_LINT_POLICY === "fail" ? "required" : "advisory"
    if (packageHasLint) {
      const lint = await runCommand(state, "npm", ["run", "lint"], 90_000, options?.signal)
      validation.push({
        name: "lint",
        status: lint.code === 0 ? "passed" : "failed",
        policy: lintPolicy,
        command: "npm run lint",
        durationMs: lint.durationMs,
        output: lint.code === 0 ? undefined : tailOutput(lint.output),
        reason: lint.timedOut ? "timeout" : lint.aborted ? "aborted" : undefined,
      })
      if (options?.signal?.aborted) {
        throw new Error("GENERATION_JOB_CANCELLED")
      }
      if (lint.code !== 0 && lintPolicy === "required") {
        throw new Error(commandFailureMessage(validation[validation.length - 1]))
      }
    } else {
      validation.push({
        name: "lint",
        status: "skipped",
        policy: lintPolicy,
        reason: "package.json has no lint script",
      })
    }

    state.status = "building"
    const build = await runCommand(state, "npm", ["run", "build"], 150_000, options?.signal)
    validation.push({
      name: "build",
      status: build.code === 0 ? "passed" : "failed",
      policy: "required",
      command: "npm run build",
      durationMs: build.durationMs,
      output: build.code === 0 ? undefined : tailOutput(build.output),
      reason: build.timedOut ? "timeout" : build.aborted ? "aborted" : undefined,
    })
    if (options?.signal?.aborted) {
      throw new Error("GENERATION_JOB_CANCELLED")
    }

    if (build.code !== 0) {
      throw new Error(commandFailureMessage(validation[validation.length - 1]))
    }

    await assertWorkspaceQuota(state)
    startPreviewServer(state)
    state.status = "verifying"
    runtimeVerification = await verifyRuntimeSmoke({
      previewUrl: state.previewUrl || `http://127.0.0.1:${state.port}`,
      files,
      signal: options?.signal,
    })
    if (!runtimeVerification.ok) {
      await stopProcess(state)
      throw new Error(`runtime verification failed: ${runtimeVerification.failureCategory || "unknown"}${runtimeVerification.error ? ` - ${runtimeVerification.error}` : ""}`)
    }
    state.status = "running"

    return {
      status: state.status,
      previewUrl: state.previewUrl,
      logs: state.logs,
      error: null,
      validation,
      runtimeVerification,
    }
  } catch (error) {
    state.status = "error"
    state.lastError = error instanceof Error ? error.message : String(error)
    appendLog(state, `Sandbox error: ${state.lastError}`)
    return {
      status: state.status,
      previewUrl: state.previewUrl,
      logs: state.logs,
      error: state.lastError,
      validation,
      runtimeVerification,
    }
  }
}

export function getRuntimeSandbox(projectId: string): StartSandboxResult {
  const state = getState(projectId)
  return {
    status: state.status,
    previewUrl: state.previewUrl,
    logs: state.logs,
    error: state.lastError,
    validation: [],
    runtimeVerification: null,
  }
}

export async function resetRuntimeSandbox(projectId: string) {
  const state = getState(projectId)
  await stopProcess(state)
  await rm(state.rootDir, { recursive: true, force: true })
  state.logs = []
  state.status = "idle"
  state.previewUrl = null
  state.lastError = null
  state.fileHash = null
  state.packageHash = null
}

async function withSandboxLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sandboxLocks.get(projectId) || Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.then(() => current, () => current)
  sandboxLocks.set(projectId, next)

  await previous.catch(() => null)
  try {
    return await operation()
  } finally {
    release()
    if (sandboxLocks.get(projectId) === next) {
      sandboxLocks.delete(projectId)
    }
  }
}

function assertFilesystemQuota(files: GeneratedFile[]) {
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(String(file.content || ""), "utf8"), 0)
  if (totalBytes > MAX_SANDBOX_SOURCE_BYTES) {
    throw new Error(`Sandbox source files exceed filesystem quota: ${totalBytes} > ${MAX_SANDBOX_SOURCE_BYTES}`)
  }
}

async function assertWorkspaceQuota(state: SandboxState) {
  const totalBytes = await directorySize(state.rootDir, {
    ignore: new Set(["node_modules"]),
  })
  if (totalBytes > MAX_SANDBOX_WORKSPACE_BYTES) {
    throw new Error(`Sandbox workspace exceeds filesystem quota: ${totalBytes} > ${MAX_SANDBOX_WORKSPACE_BYTES}`)
  }
}

async function directorySize(rootDir: string, options: { ignore: Set<string> }): Promise<number> {
  let total = 0
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (options.ignore.has(entry.name)) continue
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(entryPath, options)
      continue
    }

    const info = await stat(entryPath).catch(() => null)
    total += info?.size || 0
  }
  return total
}
