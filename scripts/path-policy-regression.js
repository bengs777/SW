const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const vm = require("node:vm")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[path-policy] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[path-policy] ${name} passed`)
}

function loadCanonicalModule(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { exports: module.exports, module, require })
  return module.exports
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const canonicalPath = read("lib/ai/canonical-path.ts")
  const filePolicy = read("lib/ai/file-policy.ts")
  const generatedArtifact = read("lib/ai/generated-artifact.ts")
  const taskGraphExecutor = read("lib/ai/task-graph-executor.ts")
  const sandboxRuntime = read("services/sandbox-runtime/server.mjs")
  const providerRouter = read("lib/ai/provider-router.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const canonicalModule = loadCanonicalModule(canonicalPath)

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:path-policy"] === "node scripts/path-policy-regression.js",
    "package.json exposes npm run test:path-policy"
  )

  const expectedCases = [
    { input: "/components/Button.tsx", expected: "components/Button.tsx", safe: true },
    { input: "./app/page.tsx", expected: "app/page.tsx", safe: true },
    { input: "src\\components\\Card.tsx", expected: "src/components/Card.tsx", safe: true },
    { input: "app\\dashboard//page.tsx", expected: "app/dashboard/page.tsx", safe: true },
    { input: "components//ui\\button.tsx", expected: "components/ui/button.tsx", safe: true },
    { input: "../lib/utils.ts", expected: "../lib/utils.ts", safe: false },
  ]

  for (const testCase of expectedCases) {
    assert(
      `canonical.case.${testCase.input}`,
      canonicalPath.includes(`input: ${JSON.stringify(testCase.input)}`) &&
        canonicalPath.includes(`expected: ${JSON.stringify(testCase.expected)}`) &&
        canonicalModule.canonicalizeGeneratedPath(testCase.input).path === testCase.expected,
      "canonical regression case is documented and executable"
    )
  }

  assert(
    "canonical.formatter",
    /export function canonicalizeGeneratedPath/.test(canonicalPath) &&
      canonicalPath.includes('replace(/^\\/+/, "")') &&
      /while \(next\.startsWith\("\.\/"\)\)/.test(canonicalPath) &&
      canonicalPath.includes('replace(/\\/{2,}/g, "/")'),
    "formatter removes leading slashes, ./ prefixes, Windows separators, and duplicate slashes"
  )

  assert(
    "validator.diagnostics",
    /class GeneratedPathValidationError/.test(filePolicy) &&
      /error:\s*"PATH_ERROR"/.test(filePolicy) &&
      /reason/.test(filePolicy) &&
      /received/.test(filePolicy) &&
      /expected/.test(filePolicy),
    "validator returns structured PATH_ERROR diagnostics"
  )

  assert(
    "validator.strict-rejects",
    /Absolute filesystem path not allowed/.test(filePolicy) &&
      /Blocked path segment not allowed/.test(filePolicy) &&
      /Blocked path pattern not allowed/.test(filePolicy) &&
      /Path must start with an allowed generated root/.test(filePolicy),
    "validator rejects absolute filesystem paths, traversal, home refs, env/git/lockfile roots"
  )

  assert(
    "pipeline.canonical-before-validation",
    /const generatedPathSchema[\s\S]*validateGeneratedPath\(path\)\.path/.test(generatedArtifact) &&
      /message:\s*JSON\.stringify\(formatGeneratedPathValidationError\(error\)\)/.test(generatedArtifact) &&
      /const path = validateGeneratedPath\(operation\.path\)\.path/.test(taskGraphExecutor),
    "parser and task graph canonicalize through centralized validation before execution"
  )

  assert(
    "sandbox.aligned-policy",
    sandboxRuntime.includes('normalized = normalized.replace(/^\\/+/, "")') &&
      /while \(normalized\.startsWith\("\.\/"\)\)/.test(sandboxRuntime) &&
      sandboxRuntime.includes('/^[a-zA-Z]:[\\\\/]/'),
    "sandbox runtime mirrors recoverable path canonicalization while rejecting drive absolutes"
  )

  assert(
    "prompts.canonical-examples",
    /Use app\/page\.tsx, components\/Button\.tsx, lib\/utils\.ts, or package\.json/.test(providerRouter) &&
      /Use app\/page\.tsx, components\/Button\.tsx, lib\/utils\.ts, or package\.json/.test(orchestrator),
    "generation prompts instruct canonical workspace-relative paths"
  )

  console.log("[path-policy] canonical path policy regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[path-policy] canonical path policy regression checks failed")
  console.error(error)
  process.exit(1)
}
