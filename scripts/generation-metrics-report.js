const { loadEnvConfig } = require("@next/env")
const { PrismaClient } = require("@prisma/client")

loadEnvConfig(process.cwd())

const prisma = new PrismaClient()

function parseJson(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function classify(metric) {
  if (metric.status !== "failed") return null
  const metadata = parseJson(metric.metadataJson)
  const raw = [metric.failureStage, metric.failureCode, metadata ? JSON.stringify(metadata) : ""].join(" ").toLowerCase()

  if (/context[_ -]?overflow|context length|token limit|too many files|max(total)?chars|64kb|maxfiles/.test(raw)) return "context_overflow"
  if (/provider|openrouter|429|rate limit|fetch failed|network|timeout|model|api key/.test(raw)) return "provider_failed"
  if (/repair|validator_deadlock|max_retries|repeated_identical|empty_repair|malformed_repair/.test(raw)) return "repair_failed"
  if (/runtime-smoke|runtime smoke|preview|sandbox|browser|page\.goto/.test(raw)) return "runtime_failed"
  if (/preview-compile|typecheck|lint|build|compile|tsc|typescript|next build|module not found/.test(raw)) return "compile_failed"
  return "validator_failed"
}

function classifyRuntime(metric) {
  if (classify(metric) !== "runtime_failed") return null
  const metadata = parseJson(metric.metadataJson)
  const raw = [metric.failureStage, metric.failureCode, metadata ? JSON.stringify(metadata) : ""].join(" ").toLowerCase()

  if (/hydration/.test(raw)) return "hydration_failed"
  if (/module not found|cannot find module|can't resolve|missing dependency/.test(raw)) return "dependency_failed"
  if (/environment|process\.env|database_url|nextauth|supabase|openrouter/.test(raw)) return "environment_failed"
  if (/import|export|does not provide an export/.test(raw)) return "import_failed"
  if (/route|api_route|homepage_render|route_render|returned 5\d\d/.test(raw)) return "route_failed"
  if (/sandbox|server_unreachable|timeout|preview server exited/.test(raw)) return "sandbox_failed"
  return "rendering_failed"
}

function classifyRendering(metric) {
  if (classifyRuntime(metric) !== "rendering_failed") return null
  const metadata = parseJson(metric.metadataJson)
  const raw = [metric.failureStage, metric.failureCode, metadata ? JSON.stringify(metadata) : ""].join(" ").toLowerCase()

  if (/client_server_boundary_failed|server component|client component|use client|event handlers cannot be passed|createcontext/.test(raw)) return "client_server_boundary_failed"
  if (/provider_missing|missing provider|must be used within|usecontext|provider/.test(raw)) return "provider_missing"
  if (/props_mismatch|props|property|undefined|null|cannot read properties|is not a function/.test(raw)) return "props_mismatch"
  if (/async_render_failed|async|promise|suspense|uncached promise|thenable/.test(raw)) return "async_render_failed"
  if (/layout_failed|root layout|layout|html|body|metadata/.test(raw)) return "layout_failed"
  if (/state_initialization_failed|usestate|initial state|initializer|reducer|setstate|state/.test(raw)) return "state_initialization_failed"
  return "component_tree_failed"
}

function percent(value, total) {
  return `${total === 0 ? 0 : Math.round((value / total) * 1000) / 10}%`
}

function rate(value, total) {
  return total === 0 ? null : Math.round((value / total) * 1000) / 10
}

function componentRegistry(metric) {
  const metadata = parseJson(metric.metadataJson)
  return metadata && typeof metadata.componentRegistry === "object" && !Array.isArray(metadata.componentRegistry)
    ? metadata.componentRegistry
    : null
}

async function main() {
  const days = Math.max(1, Math.min(90, Number(process.argv[2] || 7)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const metrics = await prisma.generationQualityMetric.findMany({
    where: { createdAt: { gte: since } },
    select: {
      status: true,
      failureStage: true,
      failureCode: true,
      buildPassed: true,
      runtimePassed: true,
      repairSucceeded: true,
      repairAttempts: true,
      metadataJson: true,
    },
  })
  const total = metrics.length
  const completed = metrics.filter((metric) => metric.status === "completed").length
  const failed = metrics.filter((metric) => metric.status === "failed")
  const breakdownCounts = {
    validator_failed: 0,
    repair_failed: 0,
    compile_failed: 0,
    runtime_failed: 0,
    context_overflow: 0,
    provider_failed: 0,
  }
  const runtimeBreakdownCounts = {
    hydration_failed: 0,
    import_failed: 0,
    dependency_failed: 0,
    route_failed: 0,
    environment_failed: 0,
    sandbox_failed: 0,
    rendering_failed: 0,
  }
  const renderingBreakdownCounts = {
    client_server_boundary_failed: 0,
    provider_missing: 0,
    props_mismatch: 0,
    async_render_failed: 0,
    layout_failed: 0,
    component_tree_failed: 0,
    state_initialization_failed: 0,
  }
  const componentGenerationAnalytics = {
    registry_reused: 0,
    registry_missing: 0,
    custom_generated: 0,
    duplicate_component: 0,
    invalid_contract: 0,
  }
  let registryUsageWeightedNumerator = 0
  let registryUsageWeightedDenominator = 0
  const registryUsageSamples = []
  for (const metric of metrics) {
    const category = classify(metric)
    if (category) breakdownCounts[category] += 1
    const runtimeCategory = classifyRuntime(metric)
    if (runtimeCategory) runtimeBreakdownCounts[runtimeCategory] += 1
    const renderingCategory = classifyRendering(metric)
    if (renderingCategory) renderingBreakdownCounts[renderingCategory] += 1
    const registry = componentRegistry(metric)
    if (registry) {
      const reused = Number(registry.reusedComponents || 0)
      const custom = Number(registry.customGeneratedComponents || 0)
      const totalComponents = Number(registry.totalComponents || reused + custom)
      registryUsageWeightedNumerator += reused
      registryUsageWeightedDenominator += totalComponents
      registryUsageSamples.push({
        selectedTemplate: registry.selectedTemplate || null,
        selectedRegistryComponents: registry.selectedRegistryComponents || [],
        generatedComponents: registry.generatedComponents || [],
        reusedComponents: reused,
        customGeneratedComponents: custom,
        registryUsageRate: Number(registry.registryUsageRate || 0),
      })
      const analytics = registry.componentGenerationAnalytics || {}
      for (const key of Object.keys(componentGenerationAnalytics)) {
        componentGenerationAnalytics[key] += Number(analytics[key] || 0)
      }
    }
  }
  const failedTotal = failed.length
  const failureBreakdown = Object.fromEntries(
    Object.entries(breakdownCounts).map(([key, value]) => [key, percent(value, failedTotal)])
  )
  const runtimeFailedTotal = breakdownCounts.runtime_failed
  const runtimeBreakdown = Object.fromEntries(
    Object.entries(runtimeBreakdownCounts).map(([key, value]) => [key, percent(value, runtimeFailedTotal)])
  )
  const renderingFailedTotal = runtimeBreakdownCounts.rendering_failed
  const renderingBreakdown = Object.fromEntries(
    Object.entries(renderingBreakdownCounts).map(([key, value]) => [key, percent(value, renderingFailedTotal)])
  )
  const repairAttempted = metrics.filter((metric) => metric.repairAttempts > 0)
  const repairSucceeded = repairAttempted.filter((metric) => metric.repairSucceeded).length
  const repairFailed = repairAttempted.length - repairSucceeded

  console.log(JSON.stringify({
    windowDays: days,
    sampleCount: total,
    failedCount: failedTotal,
    generationSuccessRate: rate(completed, total),
    runtimeFailureRate: rate(runtimeFailedTotal, total),
    renderingFailureRate: rate(renderingFailedTotal, total),
    repairSuccessRate: rate(repairSucceeded, repairAttempted.length),
    registryUsageRate: rate(registryUsageWeightedNumerator, registryUsageWeightedDenominator),
    failureBreakdown,
    failureBreakdownCounts: breakdownCounts,
    runtimeBreakdown,
    runtimeBreakdownCounts,
    renderingBreakdown,
    renderingBreakdownCounts,
    componentBreakdown: renderingBreakdown,
    componentBreakdownCounts: renderingBreakdownCounts,
    componentGenerationAnalytics,
    registryUsageSamples: registryUsageSamples.slice(-20),
    repairBreakdown: {
      attempted: repairAttempted.length,
      succeeded: repairSucceeded,
      failed: repairFailed,
      successRate: rate(repairSucceeded, repairAttempted.length),
      failedRate: rate(repairFailed, repairAttempted.length),
    },
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
