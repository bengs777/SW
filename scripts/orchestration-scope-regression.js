const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const vm = require("node:vm")

const root = process.cwd()
const moduleCache = new Map()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[orchestration-scope] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[orchestration-scope] ${name} passed`)
}

function resolveAlias(id) {
  if (!id.startsWith("@/")) return null
  const relative = id.slice(2)
  for (const candidate of [`${relative}.ts`, `${relative}.tsx`, `${relative}.js`, relative]) {
    const absolute = path.join(root, candidate)
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return absolute
  }
  return null
}

function loadTsModule(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
  if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports

  const source = fs.readFileSync(absolute, "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const loadedModule = { exports: {} }
  moduleCache.set(absolute, loadedModule)

  const localRequire = (id) => {
    const alias = resolveAlias(id)
    if (alias) return loadTsModule(alias)
    return require(id)
  }

  vm.runInNewContext(compiled, {
    __dirname: path.dirname(absolute),
    __filename: absolute,
    console,
    exports: loadedModule.exports,
    module: loadedModule,
    process,
    require: localRequire,
  })

  return loadedModule.exports
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const architectureIntent = loadTsModule("lib/ai/architecture-intent.ts")
  const intentAnalyzer = loadTsModule("lib/ai/intent-analyzer.ts")
  const generationPipeline = loadTsModule("lib/ai/generation-pipeline.ts")
  const incrementalEdit = loadTsModule("lib/ai/incremental-edit.ts")
  const filePolicy = loadTsModule("lib/ai/file-policy.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:orchestration-scope"] === "node scripts/orchestration-scope-regression.js",
    "package.json exposes npm run test:orchestration-scope"
  )

  const soto = architectureIntent.parseStructuredIntent({
    prompt: "soto restaurant homepage with hero, menu list, cart UI, checkout CTA, Tailwind, and mock data",
  })
  assert("soto.frontend-only", soto.type === "frontend_only", `expected frontend_only, got ${soto.type}`)
  assert("soto.no-backend", !soto.backend.api && !soto.database.provider && !soto.auth.provider, "soto UI prompt must not infer API/database/auth")
  assert("soto.intent", intentAnalyzer.analyzePromptIntent("soto restaurant homepage").appType === "frontend_landing", "soto homepage maps to frontend_landing")
  assert("soto.pipeline", generationPipeline.classifyPrompt("soto restaurant homepage") === "simple_ui", "soto homepage maps to simple_ui")

  const storefront = architectureIntent.parseStructuredIntent({
    prompt: "food storefront with cart, menu categories, product cards, and mobile responsive layout",
  })
  assert("storefront.frontend-only", storefront.type === "frontend_only", `expected frontend_only, got ${storefront.type}`)
  assert("storefront.no-models", storefront.database.models.length === 0 && storefront.backend.services.length === 0, "storefront UI prompt must not infer products/orders services")

  const admin = architectureIntent.parseStructuredIntent({
    prompt: "build login admin dashboard with user roles and API routes",
  })
  assert("admin.fullstack", admin.type === "fullstack_app", `expected fullstack_app, got ${admin.type}`)
  assert("admin.auth", admin.auth.provider === "nextauth", "explicit login/admin prompt may request auth")

  const existingFiles = [
    { path: "app/page.tsx", content: "export default function Page(){return <main />}", language: "tsx" },
    { path: "components/ProductCard.tsx", content: "export function ProductCard(){return <article />}", language: "tsx" },
  ]
  assert(
    "build-existing-is-edit",
    incrementalEdit.detectGenerationMode({
      prompt: "build app/page.tsx only",
      existingFiles,
    }) === "EDIT",
    "existing project prompts must prefer EDIT over BUILD"
  )
  assert(
    "fix-mode",
    incrementalEdit.detectGenerationMode({
      prompt: "fix runtime error in app/page.tsx",
      existingFiles,
    }) === "FIX",
    "fix prompts must remain FIX"
  )

  assert(
    "valid-target-path",
    filePolicy.validateGeneratedPath("./app/page.tsx").path === "app/page.tsx",
    "valid target file normalizes to canonical POSIX path"
  )
  for (const invalidPath of ["C:\\tmp\\app\\page.tsx", "../app/page.tsx", ".env", "node_modules/x.ts"]) {
    let rejected = false
    try {
      filePolicy.validateGeneratedPath(invalidPath)
    } catch {
      rejected = true
    }
    assert(`invalid-path.${invalidPath}`, rejected, "unsupported path must be rejected")
  }

  assert(
    "orchestrator.single-file-guard",
    /const singleFileOnly = explicitlyRequestedPaths\.length === 1/.test(orchestrator) &&
      /singleFileOnly \? \[\] : requiredFilesForIntent/.test(orchestrator) &&
      /singleFileOnly \? \[\] : orchestration\.plannerOutput\.requiredComponents/.test(orchestrator),
    "single-file prompts suppress required files and component expansion"
  )
  assert(
    "orchestrator.frontend-blueprint",
    /structuredIntent\.type === "frontend_only"[\s\S]*\? "frontend_landing"/.test(orchestrator),
    "frontend-only prompts select frontend_landing blueprint"
  )
  assert(
    "repair.minimal-fix",
    /const minimalRepairOnly = input\.plan\.generationMode === "FIX" \|\| syntaxRepairOnly/.test(orchestrator) &&
      /MINIMAL_FIX_MODE/.test(orchestrator) &&
      /minimalRepairOnly[\s\S]*acceptedFiles: parsed\.files\.filter/.test(orchestrator),
    "FIX repair is constrained to failing files"
  )

  console.log("[orchestration-scope] orchestration scope regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[orchestration-scope] orchestration scope regression checks failed")
  console.error(error)
  process.exit(1)
}
