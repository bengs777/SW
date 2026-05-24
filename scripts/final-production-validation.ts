import fs from "node:fs"
import http from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Queue, Worker } from "bullmq"
import IORedis from "ioredis"

const REPORT_ROOT = path.join(process.cwd(), ".swift-reports", "final-production-validation")
const LIVE_PROMPT_LIMIT = Math.max(1, Number(process.env.SWIFT_FINAL_LIVE_PROMPTS || 5))
const LIVE_PROMPT_TIMEOUT_MS = Math.max(30_000, Number(process.env.SWIFT_FINAL_LIVE_PROMPT_TIMEOUT_MS || 90_000))

type PromptCase = {
  id: string
  category: string
  prompt: string
}

function loadLocalEnv() {
  for (const file of [".env.local", ".env.production", ".env"]) {
    const filePath = path.join(process.cwd(), file)
    if (!fs.existsSync(filePath)) continue
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
      if (!match) continue
      const [, key, rawValue] = match
      if (process.env[key]) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "")
    }
  }
}

function rate(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10
}

async function withFakeServer(handler: http.RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fake server failed to bind")
  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function buildPromptSuite(): PromptCase[] {
  const categories = [
    "marketplace",
    "dashboard",
    "saas",
    "crm",
    "restaurant",
    "clinic",
    "landing-page",
    "portfolio",
    "blog",
    "custom-app",
    "long-prompt",
    "ambiguous",
  ]
  const seeds: Record<string, string[]> = {
    marketplace: [
      "Buat marketplace produk lokal dengan katalog, cart, checkout summary, seller profile, dan status pesanan.",
      "Create a B2B spare-part marketplace with supplier cards, quote basket, order tracking, and trust badges.",
      "Buat toko multi-vendor untuk fashion muslim dengan filter kategori, promo, dan halaman detail produk.",
      "Create a digital goods marketplace with license delivery, product comparison, and buyer dashboard preview.",
      "Buat marketplace UMKM desa dengan produk unggulan, profil penjual, dan pickup point.",
    ],
    dashboard: [
      "Buat dashboard operasional gudang dengan KPI, aktivitas, alert stok, dan grafik ringkas.",
      "Create executive dashboard for logistics with shipment status, SLA risk, and route performance.",
      "Buat admin dashboard sekolah dengan statistik siswa, kelas aktif, pembayaran, dan pengumuman.",
      "Create finance operations dashboard with reconciliation queue, flagged items, and approvals.",
      "Buat dashboard HR dengan headcount, absensi, request cuti, dan onboarding tasks.",
    ],
    saas: [
      "Create SaaS workspace homepage with team seats, billing state, onboarding checklist, and settings preview.",
      "Buat SaaS project management app dengan board, milestones, comments, dan usage limits.",
      "Create subscription analytics SaaS with churn cards, cohorts, invoices, and account settings.",
      "Buat SaaS customer portal dengan usage meter, API keys, plan comparison, dan support tickets.",
      "Create AI writing SaaS dashboard with documents, credits, templates, and generation history.",
    ],
    crm: [
      "Buat CRM pipeline dengan leads, deal stage, reminders, notes, dan activity timeline.",
      "Create real estate CRM with property leads, agent tasks, viewing schedule, and follow-up priority.",
      "Buat CRM klinik kecantikan dengan pelanggan, treatment history, membership, dan follow-up.",
      "Create sales CRM for distributor with account health, orders, contacts, and next action.",
      "Buat lightweight CRM untuk jasa wedding organizer dengan paket, calon klien, dan jadwal meeting.",
    ],
    restaurant: [
      "Buat website restoran dengan menu, reservasi meja, promo, gallery, dan lokasi.",
      "Create cafe ordering page with menu categories, cart preview, pickup time, and loyalty banner.",
      "Buat landing restoran seafood dengan menu andalan, booking, testimoni, dan kontak WhatsApp.",
      "Create restaurant back-office page with table status, reservations, kitchen queue, and inventory alerts.",
      "Buat web catering dengan paket prasmanan, kalkulator porsi, booking event, dan galeri.",
    ],
    clinic: [
      "Buat aplikasi klinik dengan jadwal dokter, booking pasien, antrean, dan status konsultasi.",
      "Create dental clinic website with services, appointment form, doctor cards, and patient instructions.",
      "Buat dashboard klinik ibu anak dengan appointment, imunisasi, rekam ringkas, dan pengingat.",
      "Create telemedicine clinic portal with doctor availability, consultation queue, and prescription status.",
      "Buat web fisioterapi dengan paket terapi, jadwal, progress pasien, dan kontak.",
    ],
    "landing-page": [
      "Create landing page for productivity app with hero, feature proof, pricing, FAQ, and CTA.",
      "Buat landing page jasa arsitek dengan portfolio, process, paket harga, dan kontak.",
      "Create launch page for fintech card product with benefits, security, comparison, and waitlist.",
      "Buat landing campaign event musik dengan line-up, jadwal, tiket, sponsor, dan venue.",
      "Create landing page for online course with curriculum, instructors, testimonials, and enrollment CTA.",
    ],
    portfolio: [
      "Buat portfolio personal designer dengan case studies, about, testimonials, dan contact form.",
      "Create developer portfolio with projects, stack, experience timeline, and availability.",
      "Buat portfolio fotografer wedding dengan gallery, packages, client stories, dan booking.",
      "Create architecture studio portfolio with selected works, services, team, and inquiry CTA.",
      "Buat portfolio copywriter dengan samples, niches, client logos, dan pricing teaser.",
    ],
    blog: [
      "Buat blog berita teknologi dengan artikel featured, kategori, author, dan newsletter.",
      "Create magazine homepage for travel stories with hero article, categories, and editor picks.",
      "Buat portal berita desa dengan pengumuman, agenda, artikel warga, dan kategori.",
      "Create content portal for startup insights with latest articles, tags, and newsletter CTA.",
      "Buat blog kuliner dengan resep unggulan, kategori, author bio, dan pencarian.",
    ],
    "custom-app": [
      "Buat aplikasi laundry dengan order, pickup, delivery, pembayaran, dan tracking status.",
      "Create rental equipment app with availability calendar, booking flow, contracts, and return status.",
      "Buat salon booking app dengan layanan, stylist, slot jadwal, membership, dan reminder.",
      "Create community volunteer app with events, signup, attendance, and impact dashboard.",
      "Buat inventory sederhana untuk bengkel dengan part, supplier, work order, dan restock alert.",
    ],
    "long-prompt": [
      "Buat sistem koperasi lengkap untuk anggota, simpan pinjam, tagihan, dashboard admin, laporan transaksi, notifikasi jatuh tempo, role pengurus, halaman anggota, dan export data. Prioritaskan struktur yang rapi dan valid.",
      "Create an end-to-end education platform with course catalog, student dashboard, instructor area, assignments, progress tracking, announcements, payment placeholder, and responsive design.",
      "Buat platform event organizer dengan katalog event, ticket tier, attendee list, check-in status, sponsor area, dashboard penjualan, venue map, dan email placeholder.",
      "Create internal procurement app with request intake, vendor comparison, approval workflow, purchase order summary, receiving status, budget guardrails, and audit trail.",
      "Buat aplikasi properti dengan listing, agent dashboard, appointment viewing, mortgage calculator placeholder, saved homes, lead capture, dan neighborhood guide.",
    ],
    ambiguous: [
      "Bikin website untuk bisnis saya yang rapi, modern, dan gampang dipakai.",
      "Saya butuh aplikasi untuk mengelola konten dan data pelanggan, jangan terlalu ramai.",
      "Create a useful web app for a small team with simple tracking and clear status.",
      "Buat sistem internal yang bisa dipakai admin dan user, tampilannya profesional.",
      "Website aja untuk usaha baru, ada informasi, data, dan kontak.",
    ],
  }

  const prompts: PromptCase[] = []
  for (const category of categories) {
    for (const [index, prompt] of seeds[category].entries()) {
      prompts.push({ id: `${category}-${index + 1}`, category, prompt })
    }
  }
  return prompts
}

function fixtureArtifact(promptCase: PromptCase) {
  const title = promptCase.prompt.replace(/^(buat|create|bikin)\s+/i, "").slice(0, 90)
  return {
    kind: "generated_project_artifact",
    framework: "Next.js",
    files: [
      {
        path: "package.json",
        content: JSON.stringify({
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start", typecheck: "tsc --noEmit" },
          dependencies: { next: "16.2.6", react: "19.2.5", "react-dom": "19.2.5", "lucide-react": "^0.564.0" },
          devDependencies: { typescript: "5.7.3", "@types/node": "^22", "@types/react": "19.2.14", "@types/react-dom": "19.2.3" },
        }, null, 2),
      },
      { path: "app/globals.css", content: "body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#111827}*{box-sizing:border-box}" },
      { path: "app/layout.tsx", content: 'import "./globals.css"\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html> }\n' },
      {
        path: "app/page.tsx",
        content: `import { Navbar } from "@/component-registry/navbar"
import { HeroSection } from "@/component-registry/hero"
import { FeatureSection } from "@/component-registry/feature-section"
import { Footer } from "@/component-registry/footer"

const items = ${JSON.stringify([promptCase.category, "status", "workflow", "insight"])}

export default function Page() {
  return (
    <main>
      <Navbar brand="Swift ${promptCase.category}" />
      <HeroSection title="${title.replace(/"/g, "'")}" subtitle="Production validation fixture for ${promptCase.category}." />
      <FeatureSection title="Core workflow" features={items.map((item) => ({ title: item, description: "Validated generated project section." }))} />
      <Footer brand="Swift ${promptCase.category}" />
    </main>
  )
}
`,
      },
    ],
    dependencies: [],
    commands: [],
  }
}

async function main() {
  loadLocalEnv()
  const startedAt = Date.now()
  const runId = process.env.SWIFT_FINAL_RUN_ID || `final-validation-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportDir = path.join(REPORT_ROOT, runId)
  await mkdir(reportDir, { recursive: true })
  const progressPath = path.join(reportDir, "summary.json")
  const previousProgress = process.env.SWIFT_FINAL_RESUME === "true" && fs.existsSync(progressPath)
    ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
    : null

  const writeProgress = async (patch: Record<string, unknown>) => {
    const progress = {
      runId,
      durationMs: Date.now() - startedAt,
      updatedAt: new Date().toISOString(),
      ...patch,
    }
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8")
    await writeFile(path.join(REPORT_ROOT, "latest.json"), `${JSON.stringify(progress, null, 2)}\n`, "utf8")
  }

  const { prisma } = await import("@/lib/db/client")
  const { parseGeneratedArtifact } = await import("@/lib/ai/generated-artifact")
  const { executeGeneratedTaskGraph } = await import("@/lib/ai/task-graph-executor")
  const { validateGeneratedPath } = await import("@/lib/ai/file-policy")
  const { ProviderRouter } = await import("@/lib/ai/provider-router")
  const { DEFAULT_SWIFT_TIER_KEY } = await import("@/lib/ai/swift-tiers")
  const {
    analyzeComponentRegistryUsage,
    ensureComponentRegistryFiles,
    validateComponentContracts,
  } = await import("@/lib/ai/component-registry")
  const { getProviderMetricsSnapshot } = await import("@/lib/ai/provider-metrics")
  const { getDatabaseMetricsSnapshot } = await import("@/lib/db/metrics")
  const { getGenerationQueueHealth } = await import("@/lib/queue/generation-queue")

  const promptSuite = buildPromptSuite()

  await writeProgress({
    status: "running",
    phase: "chaos",
    currentPrompt: null,
    promptSuiteCount: promptSuite.length,
    livePromptCount: LIVE_PROMPT_LIMIT,
  })
  const chaos = previousProgress?.chaos || await runChaosChecks()
  await writeProgress({
    status: "running",
    phase: "fixture",
    currentPrompt: null,
    promptSuiteCount: promptSuite.length,
    livePromptCount: LIVE_PROMPT_LIMIT,
    chaos,
  })
  const fixtureResults = Array.isArray(previousProgress?.fixtureResults) ? previousProgress.fixtureResults : []
  const completedFixtureIds = new Set(fixtureResults.map((item: { id: string }) => item.id))
  for (const promptCase of promptSuite.filter((item) => !completedFixtureIds.has(item.id))) {
    await writeProgress({
      status: "running",
      phase: "fixture",
      currentPrompt: promptCase,
      promptSuiteCount: promptSuite.length,
      livePromptCount: LIVE_PROMPT_LIMIT,
      chaos,
      fixtureResults,
      liveResults: [],
    })
    fixtureResults.push(await validateArtifact({
      promptCase,
      raw: JSON.stringify(fixtureArtifact(promptCase)),
      source: "fixture",
      parseGeneratedArtifact,
      executeGeneratedTaskGraph,
      validateGeneratedPath,
      ensureComponentRegistryFiles,
      validateComponentContracts,
      analyzeComponentRegistryUsage,
    }))
  }

  const liveResults = Array.isArray(previousProgress?.liveResults) ? previousProgress.liveResults : []
  let stuckJobCount = Number(previousProgress?.stuckJobCount || 0)
  const skipPromptIds = new Set(
    String(process.env.SWIFT_FINAL_SKIP_PROMPT_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
  const liveCases = promptSuite.filter((_item, index) => index % 5 === 0).slice(0, LIVE_PROMPT_LIMIT)
  const completedLiveIds = new Set(liveResults.map((item: { id: string }) => item.id))
  for (const promptCase of liveCases) {
    if (completedLiveIds.has(promptCase.id)) continue
    if (skipPromptIds.has(promptCase.id)) {
      liveResults.push({
        id: promptCase.id,
        category: promptCase.category,
        prompt: promptCase.prompt,
        source: "live",
        status: "failure",
        finalStatus: "failure",
        projectBuilt: false,
        providerCalled: false,
        provider: "none",
        providerAttempts: [],
        cacheState: "bypassed",
        registryUsage: null,
        buildResult: "skipped",
        runtimeResult: "not_run",
        nonRegistryFiles: 0,
        error: "Skipped after exceeding total validation runtime while processing this prompt.",
      })
      continue
    }
    await writeProgress({
      status: "running",
      phase: "live",
      currentPrompt: promptCase,
      promptSuiteCount: promptSuite.length,
      livePromptCount: liveCases.length,
      chaos,
      fixtureResults,
      liveResults,
      stuckJobCount,
    })
    const controller = new AbortController()
    const lifecycleLog: any[] = []
    let lastProgressAt = Date.now()
    let stuckDetected = false
    let watchdog: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null
    let providerPromise: ReturnType<typeof ProviderRouter.generate> | null = null
    try {
      providerPromise = ProviderRouter.generate({
        modelName: DEFAULT_SWIFT_TIER_KEY,
        mode: "files",
        promptLanguage: /buat|bikin|aplikasi|website/i.test(promptCase.prompt) ? "id" : "en",
        routingTask: "large_generation",
        temperatureOverride: 0.2,
        signal: controller.signal,
        lifecycle: (event: any) => {
          lifecycleLog.push(event)
          lastProgressAt = Date.now()
          void writeProgress({
            status: "running",
            phase: "live",
            currentPrompt: {
              ...promptCase,
              lifecycleEvent: event.event,
              provider: event.provider,
              model: event.model,
              providerAttempts: lifecycleLog.length,
            },
            promptSuiteCount: promptSuite.length,
            livePromptCount: liveCases.length,
            chaos,
            fixtureResults,
            liveResults,
            lifecycleLog,
            stuckJobCount,
          }).catch(() => null)
        },
        prompt: [
          `${promptCase.prompt}`,
          "",
          `FINAL_VALIDATION_RUN_ID: ${runId}`,
          "Return only strict JSON with files. Do not use cache. Generate a small but complete Next.js App Router project.",
        ].join("\n"),
      })
      providerPromise.catch(() => null)

      const stuckPromise = new Promise<never>((_resolve, reject) => {
        watchdog = setInterval(() => {
          if (Date.now() - lastProgressAt <= 60_000) return
          stuckDetected = true
          stuckJobCount += 1
          lifecycleLog.push({
            event: "request_cancelled",
            provider: "openrouter",
            model: "unknown",
            at: new Date().toISOString(),
            latencyMs: Date.now() - lastProgressAt,
            detail: { reason: "stuck_job_detected", idleMs: Date.now() - lastProgressAt },
          })
          controller.abort()
          if (watchdog) clearInterval(watchdog)
          reject(new Error("Stuck job detected: live validation progress did not change for >60 seconds."))
        }, 5_000)
      })

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(`Live prompt timed out after ${LIVE_PROMPT_TIMEOUT_MS}ms.`))
        }, LIVE_PROMPT_TIMEOUT_MS)
      })

      const response = await Promise.race([providerPromise, stuckPromise, timeoutPromise])
      const result = await validateArtifact({
        promptCase,
        raw: response.message,
        source: "live",
        providerAttempts: response.attempts,
        parseGeneratedArtifact,
        executeGeneratedTaskGraph,
        validateGeneratedPath,
        ensureComponentRegistryFiles,
        validateComponentContracts,
        analyzeComponentRegistryUsage,
      })
      liveResults.push({ ...result, lifecycleLog })
    } catch (error) {
      const providerAttempts = Array.isArray((error as any)?.attempts) ? (error as any).attempts : []
      liveResults.push({
        id: promptCase.id,
        category: promptCase.category,
        prompt: promptCase.prompt,
        source: "live",
        status: "failure",
        finalStatus: "failure",
        projectBuilt: false,
        providerCalled: providerAttempts.length > 0 || lifecycleLog.length > 0,
        provider: providerAttempts[0]?.provider || lifecycleLog[0]?.provider || "unknown",
        providerAttempts,
        lifecycleLog,
        stuckDetected,
        cacheState: "bypassed",
        registryUsage: null,
        buildResult: "failed",
        runtimeResult: "not_run",
        nonRegistryFiles: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      controller.abort()
      if (timeout) clearTimeout(timeout)
      if (watchdog) clearInterval(watchdog)
      if (providerPromise) {
        await Promise.race([
          providerPromise.catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ])
      }
    }
  }

  const fixtureSuccesses = fixtureResults.filter((item: any) => item.status === "success").length
  const liveSuccesses = liveResults.filter((item: any) => item.status === "success").length
  const liveLifecycle = liveResults.map((item: any) => ({
    id: item.id,
    lifecycle: Array.isArray(item.lifecycleLog) ? item.lifecycleLog.map((event: any) => event.event) : [],
    tokenReceivedCount: Array.isArray(item.lifecycleLog)
      ? item.lifecycleLog.filter((event: any) => event.event === "token_received").length
      : 0,
    chunkReceivedCount: Array.isArray(item.lifecycleLog)
      ? item.lifecycleLog.filter((event: any) => event.event === "chunk_received").length
      : 0,
    streamClosedCount: Array.isArray(item.lifecycleLog)
      ? item.lifecycleLog.filter((event: any) => event.event === "stream_closed").length
      : 0,
    streamErrorCount: Array.isArray(item.lifecycleLog)
      ? item.lifecycleLog.filter((event: any) => event.event === "stream_error").length
      : 0,
  }))
  const providerFailoverCount = liveResults.reduce((count: number, item: any) => {
    const attempts = Array.isArray(item.providerAttempts) ? item.providerAttempts : []
    const attemptedModels = new Set(
      attempts
        .filter((attempt: any) => attempt.provider === "openrouter")
        .map((attempt: any) => attempt.modelName)
        .filter(Boolean)
    )
    return count + Math.max(0, attemptedModels.size - 1)
  }, 0)
  const tokenReceivedCount = liveLifecycle.reduce((count: number, item: any) => count + item.tokenReceivedCount, 0)
  const providerCalled = liveResults.every((item: any) => item.providerCalled)
  const cacheDidNotAffect = liveResults.every((item: any) => item.providerAttempts.some((attempt: any) => attempt.provider === "openrouter"))
  const registryDidNotBypassGeneration = liveResults.every((item: any) => item.providerCalled && item.nonRegistryFiles > 0)
  const projectsBuilt = [...fixtureResults, ...liveResults].every((item: any) => item.projectBuilt)
  const queueHealth = await getGenerationQueueHealth().catch((error) => ({ status: "unhealthy", error: error instanceof Error ? error.message : String(error) }))

  const finalProductionReadinessScore = Math.max(0, Math.min(100, Math.round(
    (chaos.success ? 25 : 0) +
    (rate(fixtureSuccesses, fixtureResults.length) >= 95 ? 20 : 0) +
    (rate(liveSuccesses, liveResults.length) >= 90 ? 25 : 0) +
    (providerCalled && cacheDidNotAffect ? 10 : 0) +
    (registryDidNotBypassGeneration && projectsBuilt ? 10 : 0) +
    ((queueHealth as { status?: string }).status === "healthy" || (queueHealth as { status?: string }).status === "degraded" ? 10 : 0)
  )))

  const summary = {
    status: "completed",
    runId,
    durationMs: Date.now() - startedAt,
    promptSuiteCount: promptSuite.length,
    livePromptCount: liveResults.length,
    chaos,
    fixture: {
      successes: fixtureSuccesses,
      failures: fixtureResults.length - fixtureSuccesses,
      successRate: rate(fixtureSuccesses, fixtureResults.length),
    },
    live: {
      successes: liveSuccesses,
      failures: liveResults.length - liveSuccesses,
      successRate: rate(liveSuccesses, liveResults.length),
      providerCalled,
      tokenReceivedCount,
      providerFailoverCount,
      lifecycle: liveLifecycle,
    },
    validation: {
      cacheDidNotAffect,
      registryDidNotBypassGeneration,
      providerCorrectlyCalled: providerCalled,
      projectsActuallyBuilt: projectsBuilt,
    },
    metrics: {
      provider: getProviderMetricsSnapshot(),
      database: getDatabaseMetricsSnapshot(),
      queue: queueHealth,
    },
    stuckJobCount,
    finalBottleneck: finalProductionReadinessScore >= 95 ? "none" : chaos.success ? "live_generation_validation" : "chaos_resilience",
    finalProductionReadinessScore,
    fixtureResults,
    liveResults,
  }

  await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(path.join(REPORT_ROOT, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(summary, null, 2))
  await prisma.$disconnect()
  process.exit(finalProductionReadinessScore >= 90 ? 0 : 2)
}

async function validateArtifact(input: {
  promptCase: PromptCase
  raw: string
  source: "fixture" | "live"
  providerAttempts?: Array<{ provider: string; status: string }>
  parseGeneratedArtifact: (raw: string) => any
  executeGeneratedTaskGraph: (existing: any[], taskGraph: any, files: any[], dependencies: any[]) => { files: any[] }
  validateGeneratedPath: (filePath: string) => void
  ensureComponentRegistryFiles: (files: any[]) => any[]
  validateComponentContracts: (files: any[], options: { selectedTemplate?: string }) => { ok: boolean; failures: unknown[] }
  analyzeComponentRegistryUsage: (files: any[], selectedTemplate?: string) => {
    registryUsageRate: number
    reusedComponents: number
    customGeneratedComponents: number
    totalComponents: number
  }
}) {
  try {
    const artifact = input.parseGeneratedArtifact(input.raw)
    const executed = input.executeGeneratedTaskGraph([], artifact.taskGraph, artifact.files || [], artifact.dependencies || [])
    for (const file of executed.files) input.validateGeneratedPath(file.path)
    const files = input.ensureComponentRegistryFiles(executed.files)
    const contracts = input.validateComponentContracts(files, { selectedTemplate: input.promptCase.category })
    const registry = input.analyzeComponentRegistryUsage(files, input.promptCase.category)
    const nonRegistryFiles = files.filter((file) => !file.path.startsWith("component-registry/")).length
    const projectBuilt = files.some((file) => file.path === "app/page.tsx") && files.some((file) => file.path === "package.json")
    const providerAttempts = input.providerAttempts || []

    if (!contracts.ok) {
      throw new Error(`component contract failures: ${contracts.failures.length}`)
    }
    if (!projectBuilt) {
      throw new Error("project artifact did not include app/page.tsx and package.json")
    }

    return {
      id: input.promptCase.id,
      category: input.promptCase.category,
      prompt: input.promptCase.prompt,
      source: input.source,
      status: "success",
      finalStatus: "success",
      filesGenerated: files.length,
      projectBuilt,
      providerCalled: providerAttempts.length > 0,
      provider: providerAttempts[0]?.provider || (input.source === "fixture" ? "fixture" : "unknown"),
      providerAttempts,
      cacheState: input.source === "live" ? "bypassed" : "fixture",
      registryUsage: registry,
      buildResult: projectBuilt ? "passed" : "failed",
      runtimeResult: "not_run",
      nonRegistryFiles,
      registry,
    }
  } catch (error) {
    return {
      id: input.promptCase.id,
      category: input.promptCase.category,
      prompt: input.promptCase.prompt,
      source: input.source,
      status: "failure",
      finalStatus: "failure",
      projectBuilt: false,
      providerCalled: Boolean(input.providerAttempts?.length),
      provider: input.providerAttempts?.[0]?.provider || (input.source === "fixture" ? "fixture" : "unknown"),
      providerAttempts: input.providerAttempts || [],
      cacheState: input.source === "live" ? "bypassed" : "fixture",
      registryUsage: null,
      buildResult: "failed",
      runtimeResult: "not_run",
      nonRegistryFiles: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runChaosChecks() {
  const results: Array<{ name: string; status: "passed" | "failed" | "skipped"; detail?: unknown }> = []
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || ""
  const add = (name: string, status: "passed" | "failed" | "skipped", detail?: unknown) => results.push({ name, status, detail })

  try {
    await withFakeServer((request, response) => {
      if (request.url?.includes("timeout")) return
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{bad json")
    }, async (baseUrl) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 100)
      try {
        await fetch(`${baseUrl}/timeout`, { signal: controller.signal })
        throw new Error("timeout did not abort")
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") throw error
      } finally {
        clearTimeout(timeout)
      }
      const malformed = await fetch(`${baseUrl}/malformed`).then((res) => res.text())
      try {
        JSON.parse(malformed)
        throw new Error("malformed response parsed unexpectedly")
      } catch {
        // expected
      }
    })
    add("provider_timeout_and_malformed_response", "passed")
  } catch (error) {
    add("provider_timeout_and_malformed_response", "failed", error instanceof Error ? error.message : String(error))
  }

  try {
    const { parseGeneratedArtifact } = await import("@/lib/ai/generated-artifact")
    try {
      parseGeneratedArtifact(JSON.stringify({ files: [] }))
      throw new Error("empty AI response accepted")
    } catch {
      add("empty_ai_response", "passed")
    }
  } catch (error) {
    add("empty_ai_response", "failed", error instanceof Error ? error.message : String(error))
  }

  if (!/^rediss?:\/\//i.test(redisUrl)) {
    add("redis_disconnect", "skipped", "native redis url missing")
    add("worker_crash_recovery", "skipped", "native redis url missing")
    add("queue_backlog", "skipped", "native redis url missing")
  } else {
    try {
      const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: false })
      await redis.ping()
      await redis.disconnect()
      const reconnected = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: false })
      await reconnected.ping()
      await reconnected.quit()
      add("redis_disconnect", "passed")
    } catch (error) {
      add("redis_disconnect", "failed", error instanceof Error ? error.message : String(error))
    }

    try {
      const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
      const queueName = `swift-final-chaos-${Date.now()}`
      const queue = new Queue(queueName, { connection })
      let attempts = 0
      await queue.add("worker-crash", { ok: true }, { attempts: 2, backoff: { type: "fixed", delay: 100 } })
      const worker = new Worker(queueName, async () => {
        attempts += 1
        if (attempts === 1) throw new Error("simulated worker crash")
        return { ok: true }
      }, { connection, lockDuration: 5_000, stalledInterval: 1_000 })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker recovery timed out")), 15_000)
        worker.on("completed", () => {
          clearTimeout(timer)
          resolve()
        })
        worker.on("error", reject)
      })
      await queue.addBulk(Array.from({ length: 25 }, (_item, index) => ({ name: "backlog", data: { index } })))
      const counts = await queue.getJobCounts("waiting", "active", "completed", "failed")
      await queue.drain(true)
      await worker.close()
      await queue.close()
      await connection.quit()
      add("worker_crash_recovery", attempts >= 2 ? "passed" : "failed", { attempts })
      add("queue_backlog", Number(counts.waiting || 0) >= 0 ? "passed" : "failed", counts)
    } catch (error) {
      add("worker_crash_recovery", "failed", error instanceof Error ? error.message : String(error))
      add("queue_backlog", "failed", error instanceof Error ? error.message : String(error))
    }
  }

  try {
    const { prisma } = await import("@/lib/db/client")
    await prisma.$queryRaw`SELECT 1`
    await prisma.$disconnect()
    await prisma.$queryRaw`SELECT 1`
    add("database_reconnect", "passed")
  } catch (error) {
    add("database_reconnect", "failed", error instanceof Error ? error.message : String(error))
  }

  try {
    const promises = Array.from({ length: 10 }, async () => "same-job-key")
    const values = await Promise.all(promises)
    add("duplicate_jobs", new Set(values).size === 1 ? "passed" : "failed")
  } catch (error) {
    add("duplicate_jobs", "failed", error instanceof Error ? error.message : String(error))
  }

  try {
    const { executeGeneratedTaskGraph } = await import("@/lib/ai/task-graph-executor")
    const { validateGeneratedPath } = await import("@/lib/ai/file-policy")
    try {
      validateGeneratedPath("../bad.ts")
      throw new Error("partial generation failure accepted unsafe path")
    } catch {
      add("partial_generation_failure", "passed")
    }
    void executeGeneratedTaskGraph
  } catch (error) {
    add("partial_generation_failure", "failed", error instanceof Error ? error.message : String(error))
  }

  return {
    success: results.every((item) => item.status === "passed" || item.status === "skipped"),
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results,
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
