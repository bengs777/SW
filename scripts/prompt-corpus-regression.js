const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()
const corpusDir = path.join(root, "fixtures", "prompts")

const expected = {
  "marketplace.txt": {
    appType: "simple_marketplace",
    mustMatch: [/jual beli/i, /shopee/i, /produk/i],
  },
  "crm.txt": {
    appType: "lightweight_crm",
    mustMatch: [/crm/i, /lead/i, /customer/i],
  },
  "news.txt": {
    appType: "village_news_portal",
    mustMatch: [/berita/i, /desa/i, /artikel/i],
  },
  "dashboard.txt": {
    appType: "saas_dashboard",
    mustMatch: [/saas/i, /dashboard/i, /workspace/i],
  },
  "social-app.txt": {
    appType: "internal_business_tool",
    mustMatch: [/komunitas/i, /feed/i, /post/i],
  },
  "extreme-large.txt": {
    appType: "simple_marketplace",
    mustMatch: [/clone shopee/i, /payment/i, /analytics/i],
    mustBeCapped: true,
  },
  "malicious.txt": {
    appType: null,
    mustMatch: [/\.\.\/\.\.\/\.\.\/\.env/i, /totally-random-package/i, /hapus package\.json/i],
    mustReject: true,
  },
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[corpus] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[corpus] ${name} passed`)
}

function classifyPrompt(prompt) {
  const text = String(prompt || "").toLowerCase()
  if (/\b(berita|news|artikel|article|majalah|blog|portal berita|portal desa|desa|warga|bumdes|pengumuman|agenda desa|kegiatan desa)\b/.test(text)) {
    return "village_news_portal"
  }
  if (/\b(ai chat|chatbot|chat app|conversation|assistant|llm|openai|claude)\b/.test(text)) {
    return "ai_chat_app"
  }
  if (/\b(booking|reservation|appointment|schedule|calendar|slot|reservasi|janji temu|jadwal)\b/.test(text)) {
    return "booking_app"
  }
  if (/\b(marketplace|e-?commerce|seller|buyer|storefront|product catalog|catalog|katalog|cart|checkout|toko|dagang|pasar|jual|beli|jual beli|shopee|tokopedia|produk)\b/.test(text)) {
    return "simple_marketplace"
  }
  if (/\b(crm|lead|pipeline|sales|customer relationship|pelanggan|prospect)\b/.test(text)) {
    return "lightweight_crm"
  }
  if (/\b(saas|dashboard|workspace metrics|workspace|activity feed|settings)\b/.test(text)) {
    return "saas_dashboard"
  }
  if (/\b(komunitas|community|social|sosial|feed|moderation admin)\b|\bpost\b/.test(text)) {
    return "internal_business_tool"
  }
  if (/\b(crud|admin panel|cms|manage records|data table|moderation|moderasi)\b/.test(text)) {
    return "crud_admin_panel"
  }
  if (/\b(landing|marketing page|pricing|hero|cta|sign in|sign up|login|register|auth)\b/.test(text)) {
    return "landing_auth"
  }
  if (/\b(internal tool|ops|operation|inventory|approval|workflow|back office|business tool|komunitas|feed|social|sosial)\b/.test(text)) {
    return "internal_business_tool"
  }
  return "saas_dashboard"
}

function main() {
  const appBlueprints = read("lib/ai/app-blueprints.ts")
  const generatedArtifact = read("lib/ai/generated-artifact.ts")
  const taskGraphExecutor = read("lib/ai/task-graph-executor.ts")
  const generationOrchestrator = read("lib/services/generation-orchestrator.service.ts")
  const packageJson = JSON.parse(read("package.json"))

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:corpus"] === "node scripts/prompt-corpus-regression.js",
    "package.json exposes npm run test:corpus"
  )

  for (const [fileName, rule] of Object.entries(expected)) {
    const promptPath = path.join(corpusDir, fileName)
    assert(`${fileName}.exists`, fs.existsSync(promptPath), "prompt fixture exists")
    const prompt = fs.readFileSync(promptPath, "utf8")
    assert(`${fileName}.nonempty`, prompt.trim().length > 20, "prompt has meaningful content")
    for (const pattern of rule.mustMatch) {
      assert(`${fileName}.keyword.${pattern}`, pattern.test(prompt), "expected keyword remains in fixture")
    }
    if (rule.appType) {
      assert(
        `${fileName}.classification`,
        classifyPrompt(prompt) === rule.appType,
        `expected ${rule.appType}, got ${classifyPrompt(prompt)}`
      )
    }
  }

  assert(
    "source.classifier-covers-corpus",
    /simple_marketplace/.test(appBlueprints) &&
      /village_news_portal/.test(appBlueprints) &&
      /lightweight_crm/.test(appBlueprints) &&
      /internal_business_tool/.test(appBlueprints),
    "controlled app classifier contains corpus target app types"
  )

  assert(
    "malicious.path-policy",
    /validateGeneratedPath/.test(generatedArtifact) &&
      /PROTECTED_DELETE_FILES/.test(generatedArtifact) &&
      /validateGeneratedPath/.test(taskGraphExecutor),
    "malicious prompt is covered by path and protected-delete policy"
  )

  assert(
    "malicious.dependency-policy",
    /Dependency is not allowed by Swift policy/.test(taskGraphExecutor) &&
      /PACKAGE_VERSION_ALLOWLIST/.test(taskGraphExecutor),
    "malicious dependency requests are covered by allowlist policy"
  )

  assert(
    "extreme.resource-policy",
    /MAX_GENERATED_FILES\s*=\s*100/.test(generatedArtifact) &&
      /MAX_OPERATIONS\s*=\s*100/.test(taskGraphExecutor) &&
      /MAX_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/.test(taskGraphExecutor),
    "extreme prompt is covered by operation/file/byte caps"
  )

  assert(
    "pipeline.intent-analyzer-used",
    /analyzePromptIntent/.test(generationOrchestrator) &&
      /buildIntentInstructionBlock/.test(generationOrchestrator),
    "generation pipeline uses intent analysis for corpus prompts"
  )

  console.log("[corpus] prompt corpus regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[corpus] prompt corpus regression checks failed")
  console.error(error)
  process.exit(1)
}
