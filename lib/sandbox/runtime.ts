import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { createHash } from "crypto"
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises"
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

const SANDBOX_ROOT = path.join(process.cwd(), ".swift-sandboxes")
const BASE_PORT = Number(process.env.SWIFT_SANDBOX_BASE_PORT || 4300)
const MAX_LOG_LINES = 500

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

function runCommand(
  state: SandboxState,
  command: string,
  args: string[],
  timeoutMs: number
) {
  appendLog(state, `$ ${command} ${args.join(" ")}`)

  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(commandName(command), args, {
      cwd: state.rootDir,
      env: {
        ...process.env,
        DATABASE_URL: process.env.SWIFT_SANDBOX_DATABASE_URL || "file:./prisma/dev.db",
        NEXTAUTH_URL: `http://localhost:${state.port}`,
        NEXT_PUBLIC_APP_URL: `http://localhost:${state.port}`,
        PORT: String(state.port),
      },
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

function inferMissingPackages(output: string) {
  const packages = new Set<string>()
  const patterns = [
    /Module not found: Can't resolve ['"]([^.'"][^'"]+)['"]/g,
    /Cannot find module ['"]([^.'"][^'"]+)['"]/g,
    /Can't resolve ['"]([^.'"][^'"]+)['"]/g,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(output)) !== null) {
      const raw = match[1]
      const packageName = raw.startsWith("@")
        ? raw.split("/").slice(0, 2).join("/")
        : raw.split("/")[0]

      if (packageName && !["next", "react", "react-dom"].includes(packageName)) {
        packages.add(packageName)
      }
    }
  }

  return Array.from(packages)
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
      next: "^16.2.4",
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
    scripts: {
      ...base.scripts,
      ...(parsed.scripts || {}),
    },
    dependencies: {
      ...base.dependencies,
      ...(parsed.dependencies || {}),
    },
    devDependencies: {
      ...base.devDependencies,
      ...(parsed.devDependencies || {}),
    },
  }
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
            paths: { "@/*": ["./*"] },
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
        "DATABASE_URL=file:./prisma/dev.db",
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
    env: {
      ...process.env,
      DATABASE_URL: process.env.SWIFT_SANDBOX_DATABASE_URL || "file:./prisma/dev.db",
      NEXTAUTH_URL: `http://localhost:${state.port}`,
      NEXT_PUBLIC_APP_URL: `http://localhost:${state.port}`,
      PORT: String(state.port),
    },
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

export async function startRuntimeSandbox(projectId: string, files: GeneratedFile[]): Promise<StartSandboxResult> {
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
      const install = await runCommand(state, "npm", ["install"], 120_000)
      if (install.code !== 0) {
        throw new Error("npm install failed")
      }
      state.packageHash = nextPackageHash
    }

    state.status = "building"
    let build = await runCommand(state, "npm", ["run", "build"], 150_000)
    if (build.code !== 0) {
      const missingPackages = inferMissingPackages(build.output)
      if (missingPackages.length > 0) {
        appendLog(state, `Detected missing packages: ${missingPackages.join(", ")}`)
        const installMissing = await runCommand(state, "npm", ["install", ...missingPackages], 120_000)
        if (installMissing.code === 0) {
          build = await runCommand(state, "npm", ["run", "build"], 150_000)
        }
      }
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
