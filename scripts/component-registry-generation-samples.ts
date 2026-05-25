import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseGeneratedArtifact } from "@/lib/ai/generated-artifact"
import { normalizeGeneratedDependencies } from "@/lib/ai/generation-pipeline"
import {
  analyzeComponentRegistryUsage,
  componentRegistryPromptPayload,
  ensureComponentRegistryFiles,
  selectedRegistryComponentsForTemplate,
  validateComponentContracts,
} from "@/lib/ai/component-registry"
import { validateGeneratedPath } from "@/lib/ai/file-policy"
import { executeGeneratedTaskGraph } from "@/lib/ai/task-graph-executor"
import { ProviderRouter } from "@/lib/ai/provider-router"
import { DEFAULT_SWIFT_TIER_KEY } from "@/lib/ai/swift-tiers"
import { getReportStoragePath } from "@/lib/runtime/report-storage"
import { resetRuntimeSandbox, startRuntimeSandbox } from "@/lib/sandbox/runtime"
import type { GeneratedFile } from "@/lib/types"

type Sample = {
  id: string
  template: string
  prompt: string
}

const SAMPLES: Sample[] = [
  { id: "marketplace", template: "marketplace", prompt: "Create a marketplace homepage with seller trust, product categories, and checkout readiness." },
  { id: "dashboard", template: "dashboard", prompt: "Create an operations dashboard with KPI cards, activity status, and team alerts." },
  { id: "crm", template: "crm", prompt: "Create a CRM overview with lead pipeline, customer activity, and follow-up tasks." },
  { id: "laundry", template: "laundry", prompt: "Create a laundry service page with packages, pickup flow, and order tracking status." },
  { id: "restaurant", template: "restaurant", prompt: "Create a restaurant website with menu highlights, reservation CTA, and location details." },
  { id: "landing", template: "landing", prompt: "Create a landing page for a productivity product with proof, features, pricing, and CTA." },
  { id: "clinic", template: "clinic", prompt: "Create a clinic operations page with appointments, patient readiness, and doctor schedule highlights." },
  { id: "saas", template: "saas", prompt: "Create a SaaS workspace page with team metrics, subscription status, and onboarding CTA." },
  { id: "blog", template: "blog", prompt: "Create a blog homepage with featured article, categories, and newsletter CTA." },
  { id: "portfolio", template: "portfolio", prompt: "Create a portfolio homepage with intro, selected work, testimonial, and contact CTA." },
]

const REPORT_ROOT = path.join(getReportStoragePath(), "component-registry-samples")
const SAMPLE_TIMEOUT_MS = Number(process.env.SWIFT_COMPONENT_SAMPLE_TIMEOUT_MS || 8 * 60_000)

async function main() {
  const startedAt = Date.now()
  const runId = `registry-samples-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const reportDir = path.join(REPORT_ROOT, runId)
  await mkdir(reportDir, { recursive: true })
  const live = !process.argv.includes("--fixture")
  const keepPreview = process.argv.includes("--keep-preview")
  const results = []

  for (const sample of SAMPLES) {
    const result = await runSample(sample, reportDir, live, keepPreview)
    results.push(result)
    console.log(JSON.stringify({
      sample: sample.id,
      status: result.status,
      registryUsageRate: result.registryUsageRate,
      reusedComponents: result.reusedComponents,
      customGeneratedComponents: result.customGeneratedComponents,
      failureReason: result.failureReason || null,
    }))
  }

  const successes = results.filter((item) => item.status === "success").length
  const registryReused = results.reduce((sum, item) => sum + item.reusedComponents, 0)
  const componentTotal = results.reduce((sum, item) => sum + item.totalComponents, 0)
  const summary = {
    runId,
    mode: live ? "live" : "fixture",
    durationMs: Date.now() - startedAt,
    sampleCount: results.length,
    successes,
    failures: results.length - successes,
    generationSuccessRate: rate(successes, results.length),
    registryUsageRate: rate(registryReused, componentTotal),
    componentGenerationAnalytics: results.reduce((acc, item) => {
      for (const [key, value] of Object.entries(item.componentGenerationAnalytics)) {
        acc[key] = (acc[key] || 0) + Number(value || 0)
      }
      return acc
    }, {} as Record<string, number>),
    results,
  }
  await writeJson(path.join(reportDir, "summary.json"), summary)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failures > 0) process.exitCode = 2
}

async function runSample(sample: Sample, reportRoot: string, live: boolean, keepPreview: boolean) {
  const startedAt = Date.now()
  const projectId = `component-sample-${sample.id}-${Date.now()}`
  const dir = path.join(reportRoot, sample.id)
  await mkdir(dir, { recursive: true })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SAMPLE_TIMEOUT_MS)
  let files: GeneratedFile[] = []
  let failureReason = ""
  let sandbox: Awaited<ReturnType<typeof startRuntimeSandbox>> | null = null

  try {
    const source = live ? await generateLiveArtifact(sample) : JSON.stringify(fixtureArtifact(sample))
    await writeFile(path.join(dir, "artifact.raw.json"), source, "utf8")
    const artifact = parseGeneratedArtifact(source)
    await writeJson(path.join(dir, "artifact.json"), artifact)
    const executed = executeGeneratedTaskGraph([], artifact.taskGraph, artifact.files || [], artifact.dependencies || [])
    for (const file of executed.files) validateGeneratedPath(file.path)
    files = ensureComponentRegistryFiles(normalizeGeneratedDependencies(executed.files).files)
    const contractValidation = validateComponentContracts(files, { selectedTemplate: sample.template })
    await writeJson(path.join(dir, "component-contracts.json"), contractValidation)
    if (!contractValidation.ok) {
      throw new Error(`component contracts failed: ${contractValidation.failures.map((item) => item.message).join("; ")}`)
    }
    sandbox = await startRuntimeSandbox(projectId, files, { signal: controller.signal })
    if (sandbox.error) throw new Error(sandbox.error)
    if (!sandbox.runtimeVerification?.ok) {
      throw new Error(sandbox.runtimeVerification?.error || sandbox.runtimeVerification?.failureCategory || "runtime smoke failed")
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timeout)
    if (!keepPreview) await resetRuntimeSandbox(projectId).catch(() => null)
  }

  const usage = analyzeComponentRegistryUsage(files, sample.template)
  const result = {
    sample: sample.id,
    selectedTemplate: sample.template,
    selectedRegistryComponents: selectedRegistryComponentsForTemplate(sample.template),
    generatedComponents: usage.generatedComponents,
    reusedComponents: usage.reusedComponents,
    customGeneratedComponents: usage.customGeneratedComponents,
    totalComponents: usage.totalComponents,
    registryUsageRate: usage.registryUsageRate,
    componentGenerationAnalytics: usage.componentGenerationAnalytics,
    status: failureReason ? "failure" : "success",
    failureReason: failureReason || null,
    previewRenderPassed: Boolean(sandbox?.runtimeVerification?.ok),
    buildPassed: Boolean(sandbox?.validation.some((step) => step.name === "build" && step.status === "passed")),
    durationMs: Date.now() - startedAt,
  }
  await writeJson(path.join(dir, "result.json"), result)
  return result
}

async function generateLiveArtifact(sample: Sample) {
  const response = await ProviderRouter.generate({
    modelName: DEFAULT_SWIFT_TIER_KEY,
    mode: "files",
    promptLanguage: "en",
    routingTask: "large_generation",
    prompt: [
      sample.prompt,
      "",
      "COMPONENT_REGISTRY_GENERATION_SAMPLE:",
      "- Return only strict generated_project_artifact JSON.",
      "- Include package.json, app/layout.tsx, app/page.tsx, and app/globals.css.",
      "- Use Registry Component -> compose. Do not generate standard registry components from scratch.",
      "- If a matching standard component exists, import it from component-registry and pass valid required props.",
      "- You may generate custom domain components only when no registry component exists.",
      "- Do not create .env, lockfiles, node_modules, .git, or traversal paths.",
      JSON.stringify({
        selectedTemplate: sample.template,
        selectedRegistryComponents: selectedRegistryComponentsForTemplate(sample.template),
        componentRegistryContracts: componentRegistryPromptPayload(),
      }, null, 2),
    ].join("\n"),
  })
  await writeFile(path.join(REPORT_ROOT, "last-provider-attempts.json"), JSON.stringify(response.attempts, null, 2), "utf8").catch(() => null)
  return response.message
}

function fixtureArtifact(sample: Sample) {
  const title = sample.prompt.replace(/^Create an? /i, "").replace(/\.$/, "")
  return {
    kind: "generated_project_artifact",
    framework: "Next.js",
    files: [
      {
        path: "package.json",
        content: JSON.stringify({
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start", typecheck: "tsc --noEmit" },
          dependencies: { next: "16.2.6", react: "19.2.5", "react-dom": "19.2.5" },
          devDependencies: { typescript: "5.7.3", "@types/node": "^22", "@types/react": "19.2.14", "@types/react-dom": "19.2.3" },
        }, null, 2),
      },
      { path: "app/globals.css", content: "body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a}*{box-sizing:border-box}" },
      { path: "app/layout.tsx", content: 'import "./globals.css"\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html> }\n' },
      {
        path: "app/page.tsx",
        content: `import { Navbar } from "@/component-registry/navbar"
import { HeroSection } from "@/component-registry/hero"
import { FeatureSection } from "@/component-registry/feature-section"
import { Footer } from "@/component-registry/footer"

export default function Page() {
  return (
    <main>
      <Navbar brand="${sample.id}" />
      <HeroSection title="${title}" subtitle="Registry-composed sample for ${sample.template}." />
      <FeatureSection title="Highlights" />
      <Footer brand="${sample.id}" />
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

function rate(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
