import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createHash } from "crypto"
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import type { GeneratedFile } from "@/lib/types"

type SandboxState = {
  projectId: string
  rootDir: string
  port: number
  process: ChildProcessWithoutNullStreams | null
  logs: string[]
  status: "idle" | "installing" | "building" | "running" | "error"
  previewUrl: string | null
  lastError: string | null
  fileHash: string | null
  packageHash: string | null
}

type StartSandboxResult = {
  status: SandboxState["status"]
  previewUrl: string | null
  logs: string[]
  error: string | null
}

const SANDBOX_ROOT =
  process.env.SWIFT_SANDBOX_ROOT ||
  path.join(process.env.VERCEL ? tmpdir() : process.cwd(), ".swift-sandboxes")
const BASE_PORT = Number(process.env.SWIFT_SANDBOX_BASE_PORT || 4300)
const MAX_LOG_LINES = 500
const sandboxDatabaseUrl = () =>
  process.env.SWIFT_SANDBOX_DATABASE_URL ||
  "file:./prisma/dev.db"

const ALLOWED_PACKAGES = new Set([
  "@hookform/resolvers",
  "@libsql/client",
  "@prisma/adapter-libsql",
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
])

const globalForSandbox = globalThis as unknown as {
  swiftSandboxStates?: Map<string, SandboxState>
}

const states = globalForSandbox.swiftSandboxStates ?? new Map<string, SandboxState>()
globalForSandbox.swiftSandboxStates = states

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
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(normalizePath(file.path))
    hash.update("\0")
    hash.update(file.content || "")
    hash.update("\0")
  }
  return hash.digest("hex")
}

function commandName(command: string) {
  return process.platform === "win32" ? `${command}.cmd` : command
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
    NODE_ENV: "production",
    DATABASE_URL: sandboxDatabaseUrl(),
    NEXTAUTH_SECRET: "swift-sandbox-local-secret",
    NEXTAUTH_URL: `http://localhost:${port}`,
    NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
    PORT: String(port),
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

  return new Promise<{ code: number; output: string }>((resolve) => {
    if (signal?.aborted) {
      resolve({ code: 1, output: "Command aborted before start" })
      return
    }

    const child = spawn(commandName(command), args, {
      cwd: state.rootDir,
      env: sandboxProcessEnv(state.port),
      shell: false,
    })

    let output = ""
    const timer = setTimeout(() => {
      appendLog(state, `Command timed out after ${Math.round(timeoutMs / 1000)}s`)
      child.kill()
    }, timeoutMs)
    const abort = () => {
      appendLog(state, "Command aborted")
      child.kill()
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
      resolve({ code: code ?? 1, output })
    })
  })
}

function mergePackageJson(existingContent: string | null) {
  const base = {
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      "db:generate": "prisma generate",
      "db:push": "prisma db push",
    },
    dependencies: {
      "@prisma/client": "^5.22.0",
      "@supabase/supabase-js": "^2.104.0",
      "@libsql/client": "^0.8.1",
      "@prisma/adapter-libsql": "^5.22.0",
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
      "lucide-react": "^0.564.0",
      next: "^16.2.6",
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

  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  const packageJson = mergePackageJson(packageFile?.content || null)
  await writeFile(
    path.join(state.rootDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8"
  )

  const rootPackageLockPath = path.join(process.cwd(), "package-lock.json")
  if (await fileExists(rootPackageLockPath)) {
    const lockContent = await readFile(rootPackageLockPath, "utf8")
    await writeFile(path.join(state.rootDir, "package-lock.json"), lockContent, "utf8")
  }

  const nextConfigPath = path.join(state.rootDir, "next.config.js")
  if (!(await fileExists(nextConfigPath))) {
    await writeFile(nextConfigPath, "/** @type {import('next').NextConfig} */\nmodule.exports = {}\n", "utf8")
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

  const envPath = path.join(state.rootDir, ".env.local")
  if (!(await fileExists(envPath))) {
    await writeFile(
      envPath,
      [
        `DATABASE_URL=${sandboxDatabaseUrl()}`,
        `TURSO_DATABASE_URL=${process.env.TURSO_DATABASE_URL || ""}`,
        `TURSO_AUTH_TOKEN=${process.env.TURSO_AUTH_TOKEN || ""}`,
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
  appendLog(state, "Stopping previous dev server")
  state.process.kill()
  state.process = null
}

function startDevServer(state: SandboxState) {
  if (state.process && !state.process.killed) {
    return
  }

  const child = spawn(commandName("npm"), ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(state.port)], {
    cwd: state.rootDir,
    env: sandboxProcessEnv(state.port),
    shell: false,
  })

  state.process = child
  state.previewUrl = `http://127.0.0.1:${state.port}`
  state.status = "running"
  appendLog(state, `$ npm run dev -- --hostname 127.0.0.1 --port ${state.port}`)

  child.stdout.on("data", (chunk) => appendLog(state, String(chunk)))
  child.stderr.on("data", (chunk) => appendLog(state, String(chunk)))
  child.on("close", (code) => {
    appendLog(state, `Dev server exited with code ${code ?? 1}`)
    if (state.process === child) {
      state.process = null
      if (state.status === "running") {
        state.status = "error"
        state.lastError = `Dev server exited with code ${code ?? 1}`
      }
    }
  })
}

export async function startRuntimeSandbox(projectId: string, files: GeneratedFile[], options?: { signal?: AbortSignal }): Promise<StartSandboxResult> {
  const state = getState(projectId)
  const nextFileHash = hashFiles(files)

  try {
    state.lastError = null
    appendLog(state, `Preparing runtime sandbox for project ${projectId}`)

    if (state.fileHash !== nextFileHash) {
      await stopProcess(state)
      await ensureRuntimeFiles(state, files)
      state.fileHash = nextFileHash
    }

    const packageContent = await readFile(path.join(state.rootDir, "package.json"), "utf8")
    const nextPackageHash = createHash("sha256").update(packageContent).digest("hex")
    if (state.packageHash !== nextPackageHash || !(await fileExists(path.join(state.rootDir, "node_modules")))) {
      state.status = "installing"
      const install = await runCommand(state, "npm", ["ci", "--ignore-scripts"], 120_000, options?.signal)
      if (options?.signal?.aborted) {
        throw new Error("GENERATION_JOB_CANCELLED")
      }
      if (install.code !== 0) {
        throw new Error("npm ci failed")
      }
      state.packageHash = nextPackageHash
    }

    state.status = "building"
    const build = await runCommand(state, "npm", ["run", "build"], 150_000, options?.signal)
    if (options?.signal?.aborted) {
      throw new Error("GENERATION_JOB_CANCELLED")
    }

    if (build.code !== 0) {
      throw new Error("npm run build failed")
    }

    startDevServer(state)

    return {
      status: state.status,
      previewUrl: state.previewUrl,
      logs: state.logs,
      error: null,
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
