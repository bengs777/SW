import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/db/client"
import { env, getEnv } from "@/lib/env"
import type { GeneratedFile } from "@/lib/types"
import { UserService } from "@/lib/services/user.service"

export const runtime = "nodejs"

const MAX_FILE_COUNT = 500
const MAX_TOTAL_PAYLOAD_SIZE_BYTES = 6 * 1024 * 1024 // 6 MiB
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB

const toSafePath = (input: string) => {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized) return ""

  const safeSegments: string[] = []
  for (const segment of normalized.split("/")) {
    const trimmed = segment.trim()
    if (!trimmed || trimmed === ".") continue
    if (trimmed === "..") return ""
    safeSegments.push(trimmed)
  }

  return safeSegments.join("/")
}

type FileLike = {
  path: string
  content: string
  language?: string | null
}

type ImportBinding = {
  imported: string
  local: string
  isDefault?: boolean
}

const normalizeFiles = (raw: unknown, fallback: FileLike[]) => {
  const source = Array.isArray(raw) ? raw : fallback

  const files: GeneratedFile[] = []

  for (const entry of source) {
    const path = typeof entry?.path === "string" ? toSafePath(entry.path) : ""
    const content = typeof entry?.content === "string" ? entry.content : ""
    const language = typeof entry?.language === "string" ? entry.language : "ts"

    if (!path) continue

    files.push({
      path,
      content,
      language: language as GeneratedFile["language"],
    })
  }

  return files.slice(0, MAX_FILE_COUNT)
}

const normalizeDeployPath = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").trim()

function ensureDeploymentFiles(files: GeneratedFile[], projectName: string) {
  const byPath = new Map<string, GeneratedFile>()

  const addFile = (path: string, content: string, language: GeneratedFile["language"] = "ts") => {
    const normalized = normalizeDeployPath(path)
    if (!normalized || byPath.has(normalized)) {
      return
    }

    byPath.set(normalized, { path: normalized, content, language })
  }

  for (const file of files) {
    const normalized = normalizeDeployPath(file.path)
    if (!normalized || /\.preview\.(tsx?|jsx?)$/i.test(normalized)) {
      continue
    }

    byPath.set(normalized, {
      ...file,
      path: normalized,
      content: String(file.content || ""),
    })
  }

  const safeName = projectName.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "Swift Project"

  addFile("package.json", buildDeployPackageJson(safeName), "json")
  addFile("next.config.js", `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: false,
}

module.exports = nextConfig
`, "ts")
  addFile("tsconfig.json", buildDeployTsConfig(), "json")
  addFile("postcss.config.mjs", `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}

export default config
`, "ts")
  addFile("app/globals.css", buildDeployGlobalsCss(), "css")
  addFile("public/favicon.ico", "", "ts")

  const missingImports = collectMissingLocalImports(Array.from(byPath.values()), byPath)
  for (const missing of missingImports) {
    addFile(missing.path, buildStubModule(missing.path, missing.bindings, safeName), inferLanguageFromPath(missing.path))
  }

  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path))
}

function buildDeployPackageJson(projectName: string) {
  return JSON.stringify(
    {
      name: slugify(projectName),
      version: "0.1.0",
      private: true,
      scripts: {
        build: "next build",
        start: "next start",
      },
      dependencies: {
        "@tailwindcss/postcss": "^4.2.0",
        "autoprefixer": "^10.4.20",
        "class-variance-authority": "^0.7.1",
        "clsx": "^2.1.1",
        "lucide-react": "^0.564.0",
        "next": "^16.2.4",
        "react": "^19.2.5",
        "react-dom": "^19.2.5",
        "tailwind-merge": "^3.3.1",
        "tailwindcss": "^4.2.0",
      },
      devDependencies: {
        "@types/node": "^22",
        "@types/react": "19.2.14",
        "@types/react-dom": "19.2.3",
        "typescript": "5.7.3",
      },
    },
    null,
    2
  )
}

function buildDeployTsConfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: false,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        incremental: true,
        paths: {
          "@/*": ["./*"],
        },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2
  )
}

function buildDeployGlobalsCss() {
  return `@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #0f172a;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

a {
  color: inherit;
  text-decoration: none;
}
`
}

function collectMissingLocalImports(files: GeneratedFile[], byPath: Map<string, GeneratedFile>) {
  const missing = new Map<string, ImportBinding[]>()

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/i.test(file.path)) {
      continue
    }

    for (const found of extractLocalImports(file.content)) {
      const resolved = resolveImportPath(file.path, found.source)
      if (!resolved || byPath.has(resolved)) {
        continue
      }

      const existing = missing.get(resolved) || []
      for (const binding of found.bindings) {
        if (!existing.some((entry) => entry.local === binding.local && entry.imported === binding.imported)) {
          existing.push(binding)
        }
      }
      missing.set(resolved, existing)
    }
  }

  return Array.from(missing.entries()).map(([path, bindings]) => ({ path, bindings }))
}

function extractLocalImports(content: string) {
  const imports: Array<{ source: string; bindings: ImportBinding[] }> = []
  const re = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm
  let match: RegExpExecArray | null

  while ((match = re.exec(content))) {
    const clause = String(match[1] || "").trim()
    const source = String(match[2] || "").trim()
    if (!source.startsWith("@/") && !source.startsWith("./") && !source.startsWith("../")) {
      continue
    }

    const bindings = parseImportBindings(clause)
    if (bindings.length > 0) {
      imports.push({ source, bindings })
    }
  }

  return imports
}

function parseImportBindings(clause: string): ImportBinding[] {
  const bindings: ImportBinding[] = []
  const trimmed = clause.replace(/^type\s+/, "").trim()
  if (!trimmed || trimmed.startsWith("*")) {
    return bindings
  }

  const mixedMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]+)\}$/)
  if (mixedMatch?.[1]) {
    bindings.push({ imported: "default", local: mixedMatch[1], isDefault: true })
    bindings.push(...parseNamedImportList(mixedMatch[2]))
    return bindings
  }

  const namedMatch = trimmed.match(/^\{([\s\S]+)\}$/)
  if (namedMatch?.[1]) {
    return parseNamedImportList(namedMatch[1])
  }

  const defaultMatch = trimmed.match(/^([A-Za-z_$][\w$]*)$/)
  if (defaultMatch?.[1]) {
    bindings.push({ imported: "default", local: defaultMatch[1], isDefault: true })
  }

  return bindings
}

function parseNamedImportList(value: string): ImportBinding[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith("type "))
    .map((item) => {
      const aliasMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      const imported = aliasMatch?.[1] || item
      const local = aliasMatch?.[2] || imported
      return { imported, local }
    })
}

function resolveImportPath(fromPath: string, source: string) {
  const base = source.startsWith("@/")
    ? source.slice(2)
    : source.startsWith(".")
      ? joinRelativePath(fromPath, source)
      : ""

  if (!base) {
    return ""
  }

  const normalized = normalizeDeployPath(base)
  if (/\.(tsx?|jsx?|json|css)$/i.test(normalized)) {
    return normalized
  }

  return `${normalized}.tsx`
}

function joinRelativePath(fromPath: string, source: string) {
  const stack = normalizeDeployPath(fromPath).split("/")
  stack.pop()

  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      stack.pop()
      continue
    }
    stack.push(segment)
  }

  return stack.join("/")
}

function buildStubModule(path: string, bindings: ImportBinding[], projectName: string) {
  if (/lib\/context\/cart-context\.tsx$/i.test(path)) {
    return `"use client"

import type { ReactNode } from "react"

export function CartProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useCart() {
  return {
    items: [],
    addItem: () => {},
    removeItem: () => {},
    clearCart: () => {},
    total: 0,
  }
}
`
  }

  if (/components\/ui\/toaster\.tsx$/i.test(path)) {
    return `export function Toaster() {
  return null
}
`
  }

  const componentNames = bindings
    .map((binding) => binding.local)
    .filter((name) => /^[A-Z][A-Za-z0-9_$]*$/.test(name))
  const uniqueNames = Array.from(new Set(componentNames.length > 0 ? componentNames : ["GeneratedSection"]))

  return uniqueNames
    .map((name) => buildStubComponent(name, path, projectName))
    .join("\n\n")
}

function buildStubComponent(name: string, path: string, projectName: string) {
  const brand = JSON.stringify(projectName)
  const brandText = projectName
  const isNews = /berita|news|detik|media|portal/i.test(projectName)
  const isLaundry = /laundry|dry clean|cuci|setrika/i.test(projectName)
  const headline = isNews
    ? `Berita terbaru dan kabar pilihan dari ${brandText}`
    : isLaundry
      ? `Order laundry dan dashboard operasional untuk ${brandText}`
    : `Pengalaman digital modern untuk ${brandText}`
  const supportingCopy = isNews
    ? "Baca headline utama, topik populer, dan rangkuman berita yang dirancang agar mudah dipindai."
    : isLaundry
      ? "Kelola order form, pickup, paket layanan, status pengerjaan, dan tabel order admin."
    : "Jelajahi modul utama, fitur pilihan, dan pengalaman web yang sudah dirapikan oleh Swift AI."

  if (/navbar|header/i.test(name)) {
    return `export function ${name}() {
  return (
    <header className="sticky top-0 z-20 border-b bg-white/95 px-6 py-4 shadow-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <a className="text-xl font-black text-emerald-600" href="/">{${brand}}</a>
        <input className="hidden flex-1 rounded-md border px-4 py-2 text-sm md:block" placeholder="Cari modul..." />
        <nav className="flex items-center gap-4 text-sm font-semibold">
          <a href="/">Home</a>
          <a href="#content">Fitur</a>
        </nav>
      </div>
    </header>
  )
}`
  }

  if (/hero/i.test(name)) {
    return `export function ${name}() {
  return (
    <section className="bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500 px-6 py-16 text-white">
      <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[1.15fr_.85fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide">{${brand}}</p>
          <h1 className="mt-3 text-4xl font-black md:text-5xl">${headline}</h1>
          <p className="mt-4 max-w-xl text-white/90">${supportingCopy}</p>
          <a className="mt-6 inline-flex rounded-md bg-white px-5 py-3 text-sm font-bold text-emerald-700" href="#content">Mulai lihat</a>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {${isLaundry ? '["Order Form", "Pickup", "Status", "Admin"]' : '["Overview", "Form", "Dashboard", "Data"]'}.map((item) => (
            <div key={item} className="rounded-lg bg-white/15 p-5 shadow-lg backdrop-blur">
              <div className="text-2xl font-black">{item}</div>
              <p className="mt-2 text-sm text-white/85">Modul preview siap dicek</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}`
  }

  if (/categor/i.test(name)) {
    return `export function ${name}() {
  return (
    <section id="content" className="mx-auto max-w-6xl px-6 py-10">
      <h2 className="text-2xl font-bold">Modul Utama</h2>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-6">
        {${isLaundry ? '["Order", "Pickup", "Cuci", "Setrika", "Antar", "Invoice"]' : '["Beranda", "Form", "Admin", "Data", "Status", "Aksi"]'}.map((item) => (
          <div key={item} className="rounded-lg border bg-white p-4 text-center shadow-sm">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-emerald-100" />
            <p className="text-sm font-semibold">{item}</p>
          </div>
        ))}
      </div>
    </section>
  )
}`
  }

  if (/product|grid|featured/i.test(name)) {
    return `export function ${name}() {
  const products = ${isLaundry ? '["Order Flow", "Admin Table", "Status Panel", "Package Pricing"]' : '["Order Flow", "Admin Table", "Status Panel", "Data API"]'}
  return (
    <section className="mx-auto max-w-6xl px-6 py-10">
      <h2 className="text-2xl font-bold">Fitur Utama</h2>
      <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        {products.map((item, index) => (
          <article key={item} className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <div className="aspect-square bg-gradient-to-br from-slate-100 to-emerald-100" />
            <div className="space-y-2 p-3">
              <h3 className="line-clamp-2 text-sm font-semibold">{item}</h3>
              <p className="font-bold text-emerald-600">{["Ready", "Preview", "Mock", "Route"][index]}</p>
              <p className="text-xs text-slate-500">Modul aplikasi</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}`
  }

  if (/footer/i.test(name)) {
    return `export function ${name}() {
  return (
    <footer className="mt-10 border-t bg-slate-950 px-6 py-8 text-white">
      <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 md:flex-row">
        <div>
          <h2 className="text-xl font-black">{${brand}}</h2>
          <p className="mt-1 text-sm text-slate-300">Generated fallback page untuk project {${brand}}.</p>
        </div>
        <p className="text-sm text-slate-400">Generated by Swift AI</p>
      </div>
    </footer>
  )
}`
  }

  return `export function ${name}({ children }: { children?: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-8">
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold">${name}</h2>
        <p className="mt-2 text-sm text-slate-600">Generated fallback for ${path}.</p>
        {children}
      </div>
    </section>
  )
}`
}

function inferLanguageFromPath(path: string): GeneratedFile["language"] {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".ts")) return "ts"
  if (path.endsWith(".css")) return "css"
  if (path.endsWith(".json")) return "json"
  return "ts"
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "swift-project"

const resolveProjectFiles = async (projectId: string, userId: string) => {
  return prisma.project.findFirst({
    where: {
      id: projectId,
      workspace: {
        members: {
          some: {
            userId,
          },
        },
      },
    },
    include: {
      files: true,
    },
  })
}

type VercelCreateDeploymentResponse = {
  id?: string
  url?: string
  inspectorUrl?: string
  readyState?: string
  alias?: string[]
  error?: {
    code?: string
    message?: string
  }
  message?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const user = await UserService.createUserWithWorkspaceIfMissing(
      session.user.email,
      session.user.name ?? null,
      session.user.image ?? null
    )

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    if (!env.vercelAccessToken) {
      return NextResponse.json(
        {
          error:
            "VERCEL_ACCESS_TOKEN is missing. Set it in your environment before deploying.",
        },
        { status: 500 }
      )
    }

    const { id } = await params
  const project = await resolveProjectFiles(id, user.id)

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }

    const body = await request.json().catch(() => ({}))
    const rawFiles = normalizeFiles((body as { files?: unknown }).files, project.files)
    if (rawFiles.length === 0) {
      return NextResponse.json(
        { error: "No generated files found to deploy." },
        { status: 400 }
      )
    }
    const files = ensureDeploymentFiles(rawFiles, project.name)

    // Payload sizing guard & request logging
    const contentLengthHeader = request.headers.get("content-length")
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0

    let totalBytes = 0
    for (const f of files) {
      totalBytes += Buffer.byteLength(f.content || "", "utf8")
    }

    if (contentLength && contentLength > MAX_TOTAL_PAYLOAD_SIZE_BYTES) {
      console.warn(`[v0] Deploy aborted: Content-Length ${contentLength} exceeds limit ${MAX_TOTAL_PAYLOAD_SIZE_BYTES}`)
      return NextResponse.json(
        { error: "Payload too large (Content-Length exceeds limit)." },
        { status: 413 }
      )
    }

    if (totalBytes > MAX_TOTAL_PAYLOAD_SIZE_BYTES) {
      console.warn(`[v0] Deploy aborted: total payload ${totalBytes} bytes exceeds limit ${MAX_TOTAL_PAYLOAD_SIZE_BYTES}`)
      return NextResponse.json(
        { error: "Payload too large (generated files exceed size limit)." },
        { status: 413 }
      )
    }

    console.log(
      `[v0] Deploy payload summary: project=${project.name} files=${files.length} totalBytes=${totalBytes} contentLength=${contentLength || "n/a"} samplePaths=${files
        .slice(0, 10)
        .map((p) => p.path)
        .join(", ")}`
    )

    const payload = {
      name: slugify(project.name),
      target: "production",
      version: 2,
      files: files.map((file) => ({
        file: file.path,
        data: Buffer.from(file.content || "", "utf-8").toString("base64"),
      })),
    }

    const url = new URL("https://api.vercel.com/v13/deployments")
    const teamId = getEnv("VERCEL_TEAM_ID")
    if (teamId) {
      url.searchParams.set("teamId", teamId)
    }
    // When creating a deployment for a project that doesn't exist yet,
    // Vercel may require `projectSettings`. Skip the auto-detection confirmation
    // to allow automatic framework detection instead.
    url.searchParams.set("skipAutoDetectionConfirmation", "1")

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.vercelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    })

    const responseText = await response.text().catch(() => "")
    let data = {} as VercelCreateDeploymentResponse
    try {
      if (responseText) {
        data = JSON.parse(responseText) as VercelCreateDeploymentResponse
      }
    } catch (err) {
      console.warn("[v0] Failed to parse Vercel response as JSON", err)
    }

    if (!response.ok) {
      console.error("[v0] Vercel deployment failed", {
        status: response.status,
        body: responseText,
      })
      return NextResponse.json(
        {
          error:
            data?.error?.message ||
            data?.message ||
            `Vercel API rejected deployment (${response.status}).`,
          details: data?.error?.code,
        },
        { status: response.status }
      )
    }

    const deploymentUrl = data.url ? `https://${data.url}` : null

    return NextResponse.json({
      success: true,
      deployment: {
        id: data.id || "",
        url: deploymentUrl,
        inspectorUrl: data.inspectorUrl || null,
        readyState: data.readyState || "BUILDING",
        alias: Array.isArray(data.alias) ? data.alias : [],
      },
    })
  } catch (error) {
    console.error("[v0] Error deploying project to Vercel:", error)
    const message = error instanceof Error ? error.message : "Failed to deploy project to Vercel"
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}
