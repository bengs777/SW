import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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
const states = new Map()

function requireAuth(req, res, next) {
  if (!SERVICE_TOKEN) return next()
  const expected = `Bearer ${SERVICE_TOKEN}`
  if (req.get("authorization") !== expected) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  return next()
}

function safeSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || randomUUID()
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "")
}

function stateFor(projectId) {
  const existing = states.get(projectId)
  if (existing) return existing

  const numericHash = createHash("sha1").update(projectId).digest().readUInt32BE(0)
  const state = {
    projectId,
    rootDir: path.join(ROOT_DIR, safeSegment(projectId)),
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

function assertSafeFilePath(rootDir, filePath) {
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
  return {
    ...parsed,
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      "db:generate": "prisma generate",
      "db:push": "prisma db push",
      ...(parsed.scripts || {}),
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
      ...(parsed.dependencies || {}),
    },
    devDependencies: {
      "@tailwindcss/postcss": "^4.2.0",
      "@types/node": "^22",
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      prisma: "^5.22.0",
      tailwindcss: "^4.2.0",
      typescript: "5.7.3",
      ...(parsed.devDependencies || {}),
    },
  }
}

async function ensureFiles(state, files) {
  await mkdir(state.rootDir, { recursive: true })

  const packageFile = files.find((file) => normalizePath(file.path) === "package.json")
  const packageJson = mergePackageJson(packageFile?.content || null)
  await writeFile(path.join(state.rootDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

  if (!(await fileExists(path.join(state.rootDir, "next.config.js")))) {
    await writeFile(path.join(state.rootDir, "next.config.js"), "/** @type {import('next').NextConfig} */\nmodule.exports = {}\n", "utf8")
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
          paths: { "@/*": ["./*"] },
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
      env: {
        ...process.env,
        DATABASE_URL: process.env.SWIFT_SANDBOX_DATABASE_URL || "file:./prisma/dev.db",
        NEXTAUTH_SECRET: process.env.SWIFT_SANDBOX_NEXTAUTH_SECRET || "swift-sandbox-local-secret",
        NEXTAUTH_URL: `http://127.0.0.1:${state.port}`,
        NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${state.port}`,
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

function inferMissingPackages(output) {
  const packages = new Set()
  const patterns = [
    /Module not found: Can't resolve ['"]([^.'"][^'"]+)['"]/g,
    /Cannot find module ['"]([^.'"][^'"]+)['"]/g,
    /Can't resolve ['"]([^.'"][^'"]+)['"]/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(output)) !== null) {
      const raw = match[1]
      const packageName = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0]
      if (packageName && !["next", "react", "react-dom"].includes(packageName)) {
        packages.add(packageName)
      }
    }
  }

  return Array.from(packages)
}

async function stopProcess(state) {
  if (!state.process || state.process.killed) return
  appendLog(state, "Stopping previous dev server")
  state.process.kill()
  state.process = null
}

function publicBaseUrl(req) {
  const configured = process.env.SANDBOX_PUBLIC_BASE_URL?.replace(/\/+$/, "")
  if (configured) return configured
  const proto = req.get("x-forwarded-proto") || req.protocol || "https"
  return `${proto}://${req.get("host")}`
}

function startDevServer(state, req) {
  if (state.process && !state.process.killed) return

  const child = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(state.port)], {
    cwd: state.rootDir,
    env: {
      ...process.env,
      DATABASE_URL: process.env.SWIFT_SANDBOX_DATABASE_URL || "file:./prisma/dev.db",
      NEXTAUTH_SECRET: process.env.SWIFT_SANDBOX_NEXTAUTH_SECRET || "swift-sandbox-local-secret",
      NEXTAUTH_URL: `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}`,
      NEXT_PUBLIC_APP_URL: `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}`,
      PORT: String(state.port),
    },
    shell: false,
  })

  state.process = child
  state.previewUrl = `${publicBaseUrl(req)}/preview/${encodeURIComponent(state.projectId)}/`
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
      const install = await runCommand(state, "npm", ["install"], Number(process.env.SWIFT_SANDBOX_INSTALL_TIMEOUT_MS || 120000))
      if (install.code !== 0) throw new Error("npm install failed")
      state.packageHash = packageHash
    }

    state.status = "building"
    let build = await runCommand(state, "npm", ["run", "build"], Number(process.env.SWIFT_SANDBOX_BUILD_TIMEOUT_MS || 150000))
    if (build.code !== 0) {
      const missing = inferMissingPackages(build.output)
      if (missing.length > 0) {
        appendLog(state, `Detected missing packages: ${missing.join(", ")}`)
        const installMissing = await runCommand(state, "npm", ["install", ...missing], Number(process.env.SWIFT_SANDBOX_INSTALL_TIMEOUT_MS || 120000))
        if (installMissing.code === 0) {
          build = await runCommand(state, "npm", ["run", "build"], Number(process.env.SWIFT_SANDBOX_BUILD_TIMEOUT_MS || 150000))
        }
      }
    }
    if (build.code !== 0) throw new Error("npm run build failed")

    startDevServer(state, req)
    return state
  } catch (error) {
    state.status = "error"
    state.lastError = error instanceof Error ? error.message : String(error)
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "swift-sandbox-runtime" })
})

app.get("/sandbox/:projectId", requireAuth, (req, res) => {
  res.json(serialize(stateFor(req.params.projectId)))
})

app.post("/sandbox/:projectId", requireAuth, async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : []
  if (files.length === 0) {
    return res.status(400).json({ status: "idle", previewUrl: null, logs: [], error: "No files provided." })
  }

  const state = await startSandbox(req.params.projectId, files, req)
  return res.status(state.lastError ? 500 : 200).json(serialize(state))
})

app.delete("/sandbox/:projectId", requireAuth, async (req, res) => {
  const state = stateFor(req.params.projectId)
  await stopProcess(state)
  await rm(state.rootDir, { recursive: true, force: true })
  state.logs = []
  state.status = "idle"
  state.previewUrl = null
  state.lastError = null
  state.fileHash = null
  state.packageHash = null
  res.json({ success: true })
})

app.use("/preview/:projectId", (req, res, next) => {
  const state = stateFor(req.params.projectId)
  if (!state.process || state.status !== "running") {
    return res.status(503).send("Sandbox preview is not running.")
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

const port = Number(process.env.PORT || 8080)
app.listen(port, () => {
  console.log(`swift-sandbox-runtime listening on ${port}`)
})
