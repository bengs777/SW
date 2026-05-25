import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseGeneratedArtifact, type GeneratedArtifact } from "@/lib/ai/generated-artifact"
import { normalizeGeneratedDependencies } from "@/lib/ai/generation-pipeline"
import { ProviderRouter, type ProviderAttemptLog } from "@/lib/ai/provider-router"
import { DEFAULT_SWIFT_TIER_KEY } from "@/lib/ai/swift-tiers"
import { executeGeneratedTaskGraph } from "@/lib/ai/task-graph-executor"
import { validateGeneratedPath } from "@/lib/ai/file-policy"
import { getReportStoragePath } from "@/lib/runtime/report-storage"
import { startRuntimeSandbox, resetRuntimeSandbox, type SandboxValidationStep } from "@/lib/sandbox/runtime"
import type { RuntimeSmokeResult } from "@/lib/sandbox/runtime-smoke"
import type { GeneratedFile } from "@/lib/types"

type ScenarioKey = "pos-app" | "dashboard-admin" | "todo-app" | "auth-app" | "crud-inventory"
type GenerationMode = "fixture" | "live" | "replay"
type StageStatus = "passed" | "failed" | "skipped"

type Scenario = {
  key: ScenarioKey
  label: string
  prompt: string
}

type StageTrace = {
  name: string
  status: StageStatus
  durationMs: number
  message?: string
  data?: Record<string, unknown>
}

type RepairAttemptReport = {
  attempt: number
  reason: string
  changedFiles: string[]
  durationMs: number
  status: StageStatus
}

type ScenarioReport = {
  scenario: ScenarioKey
  label: string
  prompt: string
  mode: GenerationMode
  status: "success" | "failure"
  buildPassed: boolean
  previewStarted: boolean
  previewRenderPassed: boolean
  retryCount: number
  filesGenerated: number
  durationMs: number
  artifactValidationPassed: boolean
  dependencyResolutionPassed: boolean
  repairSucceeded: boolean
  runtimeStable: boolean
  previewUrl: string | null
  failureReason?: string
  stages: StageTrace[]
  providerAttempts: ProviderAttemptLog[]
  sandboxValidation: SandboxValidationStep[]
  runtimeVerification: RuntimeSmokeResult | null
  repairAttempts: RepairAttemptReport[]
  artifactPath: string
  reportDir: string
}

type SummaryReport = {
  status: "success" | "failure"
  mode: GenerationMode
  runId: string
  durationMs: number
  scenarios: number
  successes: number
  failures: number
  successRate: number
  averageRetries: number
  averageGenerationDurationMs: number
  buildSuccessRate: number
  repairSuccessRate: number
  previewRenderSuccessRate: number
  reports: string[]
  score: {
    artifactValidation: "PASS" | "FAIL"
    build: "PASS" | "FAIL"
    preview: "PASS" | "FAIL"
    runtimeStability: "PASS" | "FAIL"
  }
}

const SCENARIOS: Scenario[] = [
  {
    key: "pos-app",
    label: "POS app",
    prompt: "Create a production-safe POS app preview with product catalog, cart, checkout summary, and daily sales status.",
  },
  {
    key: "dashboard-admin",
    label: "Dashboard admin",
    prompt: "Create an admin dashboard with KPI cards, user table, activity feed, and operational alerts.",
  },
  {
    key: "todo-app",
    label: "Todo app",
    prompt: "Create a todo app with filters, task list, completion states, and a small API health endpoint.",
  },
  {
    key: "auth-app",
    label: "Auth app",
    prompt: "Create an auth app preview with sign in, registration, protected area states, and auth status endpoint.",
  },
  {
    key: "crud-inventory",
    label: "CRUD inventory app",
    prompt: "Create a CRUD inventory app with item table, stock status, add item form, and inventory API endpoint.",
  },
]

const DEFAULT_REPORT_ROOT = path.join(getReportStoragePath(), "e2e-generation")
const MAX_REPAIR_ATTEMPTS = 2
const SCENARIO_TIMEOUT_MS = Number(process.env.SWIFT_E2E_GENERATION_TIMEOUT_MS || 10 * 60 * 1000)

if (!process.env.SWIFT_SANDBOX_COPY_ROOT_LOCK) {
  process.env.SWIFT_SANDBOX_COPY_ROOT_LOCK = "true"
}

async function main() {
  const startedAt = Date.now()
  const args = parseArgs(process.argv.slice(2))
  const runId = args.runId || `generation-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportRoot = path.resolve(args.outDir || DEFAULT_REPORT_ROOT, runId)
  await mkdir(reportRoot, { recursive: true })

  const replay = args.replayPath ? await loadReplay(args.replayPath) : null
  const mode: GenerationMode = replay ? "replay" : args.live ? "live" : "fixture"
  const scenarios = replay
    ? [replay.scenario]
    : SCENARIOS.filter((scenario) => args.scenario === "all" || scenario.key === args.scenario)

  if (scenarios.length === 0) {
    throw new Error(`No scenario matched: ${args.scenario}`)
  }

  const reports: ScenarioReport[] = []
  for (const scenario of scenarios) {
    const report = await runScenario({
      scenario,
      mode,
      reportRoot,
      keepPreview: args.keepPreview,
      replayArtifact: replay?.artifact || null,
    })
    reports.push(report)
  }

  const summary = buildSummary(mode, runId, Date.now() - startedAt, reports)
  const summaryPath = path.join(reportRoot, "summary.json")
  await writeJson(summaryPath, summary)

  printSummary(summary, reports)
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
  }

  if (summary.status !== "success" && args.strict) {
    process.exitCode = 2
  }
}

async function runScenario(input: {
  scenario: Scenario
  mode: GenerationMode
  reportRoot: string
  keepPreview: boolean
  replayArtifact: unknown | null
}): Promise<ScenarioReport> {
  const startedAt = Date.now()
  const projectId = `e2e-${input.scenario.key}-${Date.now()}`
  const scenarioDir = path.join(input.reportRoot, input.scenario.key)
  await mkdir(scenarioDir, { recursive: true })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SCENARIO_TIMEOUT_MS)

  const stages: StageTrace[] = []
  const repairs: RepairAttemptReport[] = []
  let providerAttempts: ProviderAttemptLog[] = []
  let sandboxValidation: SandboxValidationStep[] = []
  let runtimeVerification: RuntimeSmokeResult | null = null
  let previewUrl: string | null = null
  let failureReason = ""
  let artifact: GeneratedArtifact | null = null
  let files: GeneratedFile[] = []
  let artifactValidationPassed = false
  let dependencyResolutionPassed = false
  const artifactPath = path.join(scenarioDir, "artifact.json")

  const stage = async <T>(name: string, fn: () => Promise<T>, data?: Record<string, unknown>) => {
    const stageStartedAt = Date.now()
    try {
      const result = await fn()
      stages.push({ name, status: "passed", durationMs: Date.now() - stageStartedAt, data })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stages.push({ name, status: "failed", durationMs: Date.now() - stageStartedAt, message, data })
      throw error
    }
  }

  try {
    await stage("prompt", async () => {
      await writeJson(path.join(scenarioDir, "prompt.json"), {
        scenario: input.scenario.key,
        label: input.scenario.label,
        prompt: input.scenario.prompt,
        mode: input.mode,
      })
    })

    const plan = await stage("planner", async () => planScenario(input.scenario))
    await writeJson(path.join(scenarioDir, "plan.json"), plan)

    const artifactSource = await stage("artifact_generation", async () => {
      if (input.mode === "replay") return JSON.stringify(input.replayArtifact)
      if (input.mode === "live") {
        const response = await ProviderRouter.generate({
          modelName: DEFAULT_SWIFT_TIER_KEY,
          mode: "files",
          promptLanguage: "en",
          routingTask: "large_generation",
          prompt: buildLiveGenerationPrompt(input.scenario, plan),
        })
        providerAttempts = response.attempts
        await writeJson(path.join(scenarioDir, "provider-attempts.json"), response.attempts)
        return response.message
      }
      return JSON.stringify(buildFixtureArtifact(input.scenario, plan))
    })

    await writeFile(path.join(scenarioDir, "artifact.raw.json"), artifactSource, "utf8")

    artifact = await stage("canonicalization", async () => parseGeneratedArtifact(artifactSource))
    await writeJson(artifactPath, artifact)

    files = await stage("validation", async () => {
      const executed = executeGeneratedTaskGraph([], artifact?.taskGraph, artifact?.files || [], artifact?.dependencies || [])
      for (const file of executed.files) {
        validateGeneratedPath(file.path)
      }
      artifactValidationPassed = true
      return executed.files
    }, { parsedFiles: artifact.files.length, taskGraphOperations: artifact.taskGraph?.operations.length || 0 })

    files = await stage("dependency_resolution", async () => {
      const normalized = normalizeGeneratedDependencies(files)
      dependencyResolutionPassed = true
      await writeJson(path.join(scenarioDir, "dependency-resolution.json"), {
        addedPackages: normalized.addedPackages,
        normalizedPackages: normalized.normalizedPackages,
        conflictsPrevented: normalized.conflictsPrevented,
      })
      return normalized.files
    })

    await writeJson(path.join(scenarioDir, "generated-files.json"), files)

    let sandbox = await stage("build_preview_startup", async () => startRuntimeSandbox(projectId, files, { signal: controller.signal }))
    sandboxValidation = sandbox.validation
    runtimeVerification = sandbox.runtimeVerification
    previewUrl = sandbox.previewUrl

    let repairAttempt = 0
    while ((sandbox.error || !runtimeVerification?.ok) && repairAttempt < MAX_REPAIR_ATTEMPTS) {
      repairAttempt += 1
      const repairStartedAt = Date.now()
      const repaired = stabilizeGeneratedFiles(files, sandbox.error || runtimeVerification?.error || "preview failed")
      files = repaired.files
      repairs.push({
        attempt: repairAttempt,
        reason: repaired.reason,
        changedFiles: repaired.changedFiles,
        durationMs: Date.now() - repairStartedAt,
        status: repaired.changedFiles.length > 0 ? "passed" : "skipped",
      })
      await writeJson(path.join(scenarioDir, `repair-${repairAttempt}.json`), {
        reason: repaired.reason,
        changedFiles: repaired.changedFiles,
        files,
      })
      if (repaired.changedFiles.length === 0) break
      sandbox = await stage(`repair_loop_${repairAttempt}`, async () => startRuntimeSandbox(projectId, files, { signal: controller.signal }))
      sandboxValidation = sandbox.validation
      runtimeVerification = sandbox.runtimeVerification
      previewUrl = sandbox.previewUrl
    }

    await writeJson(path.join(scenarioDir, "sandbox-validation.json"), {
      validation: sandboxValidation,
      runtimeVerification,
      previewUrl,
      logs: sandbox.logs,
      error: sandbox.error,
    })

    if (sandbox.error) {
      failureReason = sandbox.error
    } else if (!runtimeVerification?.ok) {
      failureReason = runtimeVerification?.error || runtimeVerification?.failureCategory || "preview verification failed"
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error)
    await writeJson(path.join(scenarioDir, "failure.json"), {
      error: failureReason,
      stages,
      artifact,
      files,
      repairs,
      sandboxValidation,
      runtimeVerification,
    })
  } finally {
    clearTimeout(timeout)
    if (!input.keepPreview) {
      await resetRuntimeSandbox(projectId).catch(() => null)
    }
  }

  const buildPassed = sandboxValidation.some((step) => step.name === "build" && step.status === "passed")
  const previewStarted = Boolean(previewUrl) && !failureReason
  const previewRenderPassed = Boolean(runtimeVerification?.ok)
  const status = artifactValidationPassed && dependencyResolutionPassed && buildPassed && previewRenderPassed ? "success" : "failure"

  const report: ScenarioReport = {
    scenario: input.scenario.key,
    label: input.scenario.label,
    prompt: input.scenario.prompt,
    mode: input.mode,
    status,
    buildPassed,
    previewStarted,
    previewRenderPassed,
    retryCount: repairs.length,
    filesGenerated: files.length,
    durationMs: Date.now() - startedAt,
    artifactValidationPassed,
    dependencyResolutionPassed,
    repairSucceeded: repairs.some((repair) => repair.status === "passed") && status === "success",
    runtimeStable: previewRenderPassed && !runtimeVerification?.checks.some((check) => check.status === "failed"),
    previewUrl,
    failureReason: status === "failure" ? failureReason || "generation pipeline failed" : undefined,
    stages,
    providerAttempts,
    sandboxValidation,
    runtimeVerification,
    repairAttempts: repairs,
    artifactPath,
    reportDir: scenarioDir,
  }

  await writeJson(path.join(scenarioDir, "report.json"), report)
  await writeJson(path.join(scenarioDir, "replay.json"), {
    scenario: input.scenario,
    artifact,
    repairAttempts: repairs,
  })
  return report
}

function planScenario(scenario: Scenario) {
  const commonFiles = ["package.json", "app/layout.tsx", "app/page.tsx", "app/globals.css"]
  const apiFile =
    scenario.key === "todo-app"
      ? "app/api/todos/route.ts"
      : scenario.key === "auth-app"
        ? "app/api/auth/status/route.ts"
        : scenario.key === "crud-inventory"
          ? "app/api/inventory/route.ts"
          : null

  return {
    scenario: scenario.key,
    framework: "Next.js",
    stages: [
      "prompt",
      "planner",
      "artifact_generation",
      "canonicalization",
      "validation",
      "repair_loop",
      "dependency_resolution",
      "build",
      "preview_startup",
      "success_verification",
    ],
    targetFiles: apiFile ? [...commonFiles, apiFile] : commonFiles,
    previewChecks: ["server_reachable", "root_rendered", "dom_available", "no_hydration_errors", "no_blank_screen"],
  }
}

function buildLiveGenerationPrompt(scenario: Scenario, plan: ReturnType<typeof planScenario>) {
  return [
    scenario.prompt,
    "",
    "E2E_GENERATION_TEST_CONTRACT:",
    "- Return only strict generated_project_artifact JSON.",
    "- Use framework metadata for Next.js, React, and TypeScript labels.",
    "- Generate a compact but real first usable project.",
    "- Include package.json, app/layout.tsx, app/page.tsx, and app/globals.css.",
    "- Use only deterministic local/static data unless an API route is requested by the scenario.",
    "- commands must be [].",
    "- Do not create .env, lockfiles, node_modules, .git, or traversal paths.",
    JSON.stringify(plan, null, 2),
  ].join("\n")
}

function buildFixtureArtifact(scenario: Scenario, plan: ReturnType<typeof planScenario>) {
  const operations = plan.targetFiles.map((filePath) => ({
    id: `write-${filePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`,
    action: "create" as const,
    path: filePath,
    language: languageForPath(filePath),
    content: contentForFile(scenario, filePath),
    reason: `Create ${scenario.label} ${filePath}`,
  }))

  return {
    kind: "generated_project_artifact",
    framework: "Next.js",
    files: [],
    dependencies: [],
    commands: [],
    summary: `Generated deterministic ${scenario.label} fixture.`,
    diagnostics: [],
    metadata: {
      scenario: scenario.key,
      framework: "Next.js",
      labels: ["React", "TypeScript"],
      deterministic: true,
    },
    repairs: [],
    taskGraph: {
      intent: scenario.prompt,
      summary: `Create ${scenario.label}.`,
      dependencies: [],
      operations,
    },
  }
}

function contentForFile(scenario: Scenario, filePath: string) {
  if (filePath === "package.json") {
    return JSON.stringify({
      name: `swift-e2e-${scenario.key}`,
      private: true,
      version: "0.1.0",
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
      },
      dependencies: {
        next: "16.2.6",
        react: "19.2.5",
        "react-dom": "19.2.5",
      },
      devDependencies: {
        "@types/node": "^22",
        "@types/react": "19.2.14",
        "@types/react-dom": "19.2.3",
        eslint: "^9.39.4",
        "eslint-config-next": "^16.2.6",
        typescript: "5.7.3",
      },
    }, null, 2) + "\n"
  }

  if (filePath === "app/layout.tsx") {
    return [
      'import "./globals.css"',
      "",
      "export const metadata = {",
      `  title: "${scenario.label} - Swift E2E",`,
      '  description: "Deterministic generated project for Swift E2E validation",',
      "}",
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      '  return <html lang="en"><body>{children}</body></html>',
      "}",
      "",
    ].join("\n")
  }

  if (filePath === "app/globals.css") {
    return [
      "body {",
      "  margin: 0;",
      "  font-family: Arial, Helvetica, sans-serif;",
      "  background: #f7f8fb;",
      "  color: #172033;",
      "}",
      "* { box-sizing: border-box; }",
      ".shell { min-height: 100vh; padding: 32px; }",
      ".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }",
      ".panel { background: white; border: 1px solid #d8deea; border-radius: 8px; padding: 18px; }",
      ".muted { color: #5f6c80; }",
      ".status { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #e8f5ef; color: #17603a; font-size: 12px; }",
      "button, input { font: inherit; }",
      "",
    ].join("\n")
  }

  if (filePath === "app/api/todos/route.ts") {
    return 'export async function GET() { return Response.json({ ok: true, todos: [{ id: 1, title: "Ship E2E tests", completed: false }] }) }\n'
  }

  if (filePath === "app/api/auth/status/route.ts") {
    return 'export async function GET() { return Response.json({ ok: true, authenticated: false, provider: "demo" }) }\n'
  }

  if (filePath === "app/api/inventory/route.ts") {
    return 'export async function GET() { return Response.json({ ok: true, items: [{ sku: "SKU-001", name: "Keyboard", stock: 18 }] }) }\n'
  }

  return pageForScenario(scenario)
}

function pageForScenario(scenario: Scenario) {
  if (scenario.key === "pos-app") {
    return pageTemplate("POS Terminal", "Checkout ready", [
      ["Products", "24 active SKUs"],
      ["Cart", "3 items selected"],
      ["Today", "$1,248 sales"],
    ], "Fast checkout lane with catalog, cart, discount, and tender summary.")
  }

  if (scenario.key === "dashboard-admin") {
    return pageTemplate("Admin Dashboard", "Operations healthy", [
      ["Users", "1,284"],
      ["Open tickets", "18"],
      ["Deployments", "7 today"],
    ], "KPI cards, operator table, alert queue, and recent activity are ready for review.")
  }

  if (scenario.key === "todo-app") {
    return pageTemplate("Todo Workspace", "API backed", [
      ["Open", "5 tasks"],
      ["Done", "12 tasks"],
      ["Focus", "2 due today"],
    ], "Filter tasks, mark progress, and verify the /api/todos endpoint from the preview smoke test.")
  }

  if (scenario.key === "auth-app") {
    return pageTemplate("Auth Portal", "Session preview", [
      ["Sign in", "Email route"],
      ["Register", "Ready"],
      ["Protected", "Locked state"],
    ], "Authentication states render deterministically with a status endpoint for runtime verification.")
  }

  return pageTemplate("Inventory Manager", "CRUD ready", [
    ["Items", "132"],
    ["Low stock", "9"],
    ["Warehouses", "3"],
  ], "Inventory table, stock status, item form, and /api/inventory endpoint are ready.")
}

function pageTemplate(title: string, status: string, cards: Array<[string, string]>, body: string) {
  return [
    "const cards = " + JSON.stringify(cards.map(([label, value]) => ({ label, value })), null, 2),
    "",
    "export default function Page() {",
    "  return (",
    '    <main className="shell" data-testid="swift-root">',
    '      <section className="panel" style={{ marginBottom: 16 }}>',
    `        <span className="status">${status}</span>`,
    `        <h1>${title}</h1>`,
    `        <p className="muted">${body}</p>`,
    "      </section>",
    '      <section className="grid" aria-label="Generation smoke cards">',
    "        {cards.map((card) => (",
    '          <article className="panel" key={card.label}>',
    "            <h2>{card.label}</h2>",
    "            <p>{card.value}</p>",
    "          </article>",
    "        ))}",
    "      </section>",
    "    </main>",
    "  )",
    "}",
    "",
  ].join("\n")
}

function stabilizeGeneratedFiles(files: GeneratedFile[], reason: string) {
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]))
  const changedFiles: string[] = []

  const ensure = (file: GeneratedFile) => {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file)
      changedFiles.push(file.path)
    }
  }

  ensure({
    path: "app/page.tsx",
    language: "tsx",
    content: pageTemplate("Stabilized Preview", "Recovered", [["Preview", "Rendered"], ["Build", "Recovered"]], "Fallback root render inserted by the e2e repair loop."),
  })
  ensure({
    path: "app/layout.tsx",
    language: "tsx",
    content: contentForFile(SCENARIOS[0], "app/layout.tsx"),
  })
  ensure({
    path: "app/globals.css",
    language: "css",
    content: contentForFile(SCENARIOS[0], "app/globals.css"),
  })

  return {
    files: Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path)),
    changedFiles,
    reason,
  }
}

function buildSummary(mode: GenerationMode, runId: string, durationMs: number, reports: ScenarioReport[]): SummaryReport {
  const successes = reports.filter((report) => report.status === "success").length
  const buildSuccesses = reports.filter((report) => report.buildPassed).length
  const previewSuccesses = reports.filter((report) => report.previewRenderPassed).length
  const repairAttempts = reports.reduce((sum, report) => sum + report.retryCount, 0)
  const repairNeeded = reports.filter((report) => report.retryCount > 0)
  const repairSuccesses = repairNeeded.filter((report) => report.repairSucceeded || report.status === "success").length
  const scenarioCount = reports.length || 1

  return {
    status: successes === reports.length ? "success" : "failure",
    mode,
    runId,
    durationMs,
    scenarios: reports.length,
    successes,
    failures: reports.length - successes,
    successRate: roundRate(successes / scenarioCount),
    averageRetries: round(repairAttempts / scenarioCount),
    averageGenerationDurationMs: Math.round(reports.reduce((sum, report) => sum + report.durationMs, 0) / scenarioCount),
    buildSuccessRate: roundRate(buildSuccesses / scenarioCount),
    repairSuccessRate: repairNeeded.length === 0 ? 1 : roundRate(repairSuccesses / repairNeeded.length),
    previewRenderSuccessRate: roundRate(previewSuccesses / scenarioCount),
    reports: reports.map((report) => path.join(report.reportDir, "report.json")),
    score: {
      artifactValidation: reports.every((report) => report.artifactValidationPassed) ? "PASS" : "FAIL",
      build: reports.every((report) => report.buildPassed) ? "PASS" : "FAIL",
      preview: reports.every((report) => report.previewRenderPassed) ? "PASS" : "FAIL",
      runtimeStability: reports.every((report) => report.runtimeStable) ? "PASS" : "FAIL",
    },
  }
}

function printSummary(summary: SummaryReport, reports: ScenarioReport[]) {
  console.log("")
  console.log("Generation Score:")
  console.log(`- artifact validation: ${summary.score.artifactValidation}`)
  console.log(`- build: ${summary.score.build}`)
  console.log(`- preview: ${summary.score.preview}`)
  console.log(`- runtime stability: ${summary.score.runtimeStability}`)
  console.log("")
  console.log(`Success rate: ${summary.successes}/${summary.scenarios} (${Math.round(summary.successRate * 100)}%)`)
  console.log(`Average retries: ${summary.averageRetries}`)
  console.log(`Average duration: ${summary.averageGenerationDurationMs}ms`)
  console.log(`Build success rate: ${Math.round(summary.buildSuccessRate * 100)}%`)
  console.log(`Preview render success: ${Math.round(summary.previewRenderSuccessRate * 100)}%`)
  console.log("")
  for (const report of reports) {
    console.log(`${report.status === "success" ? "PASS" : "FAIL"} ${report.label} - ${report.durationMs}ms - ${path.join(report.reportDir, "report.json")}`)
    if (report.failureReason) console.log(`  reason: ${report.failureReason}`)
  }
}

async function loadReplay(replayPath: string): Promise<{ scenario: Scenario; artifact: unknown }> {
  const absolute = path.resolve(replayPath)
  const raw = JSON.parse(await readFile(absolute, "utf8")) as {
    scenario?: Scenario
    artifact?: unknown
  }
  if (!raw.scenario || !raw.artifact) {
    throw new Error(`Replay file must include scenario and artifact: ${absolute}`)
  }
  return { scenario: raw.scenario, artifact: raw.artifact }
}

function parseArgs(args: string[]) {
  const value = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? "" : args[index + 1] || ""
  }

  return {
    live: args.includes("--live"),
    strict: args.includes("--strict"),
    json: args.includes("--json"),
    keepPreview: args.includes("--keep-preview"),
    scenario: (value("--scenario") || "all") as ScenarioKey | "all",
    replayPath: value("--replay"),
    outDir: value("--out"),
    runId: value("--run-id"),
  }
}

function languageForPath(filePath: string): GeneratedFile["language"] {
  if (filePath.endsWith(".tsx")) return "tsx"
  if (filePath.endsWith(".ts")) return "ts"
  if (filePath.endsWith(".css")) return "css"
  if (filePath.endsWith(".json")) return "json"
  if (filePath.endsWith(".md")) return "md"
  if (filePath.endsWith(".prisma")) return "prisma"
  if (filePath.endsWith(".env")) return "env"
  return "ts"
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").trim()
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function roundRate(value: number) {
  return Math.round(value * 1000) / 1000
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

main().catch((error) => {
  console.error("[e2e-generation] failed")
  console.error(error)
  process.exit(1)
})
