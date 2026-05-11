const fs = require("fs")
const path = require("path")

const root = process.cwd()

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[regression] ${name} failed${detail ? `: ${detail}` : ""}`)
  }

  console.log(`[regression] ${name} passed`)
}

const sandboxPreview = read("components/editor/sandbox-preview.tsx")
const generateRoute = read("app/api/generate/route.ts")

assert(
  "runtime repair uses virtual boundary import",
  sandboxPreview.includes('injectVirtualModuleImport(') &&
    sandboxPreview.includes("/@preview/components/swift-safe-error-boundary.tsx"),
  "runtime repair must inject a virtual module specifier, not a raw alias"
)

assert(
  "runtime repair never injects raw safe-boundary alias",
  !/source\s*=\s*['"`]import\s+\{\s*SwiftSafeErrorBoundary\s*\}\s+from\s+["']@\/components\/swift-safe-error-boundary/.test(sandboxPreview),
  "raw @/ safe-boundary import cannot be injected after compileProject"
)

assert(
  "stale boundary is warning before pre-blob",
  /runtime\.stale_error_boundary_warning/.test(sandboxPreview) &&
    /rewriteStaleErrorBoundaryReferences\(path, content, 'pre-transform'\)/.test(sandboxPreview) &&
    /rewriteStaleErrorBoundaryReferences\(path, result\.code, 'post-babel'\)/.test(sandboxPreview) &&
    /assertNoStaleErrorBoundary\(path, code, 'pre-blob'\)/.test(sandboxPreview),
  "stale boundary must be repairable before the final hard assertion"
)

assert(
  "runtime repair telemetry is tagged",
  /repair_source:\s*'runtime'/.test(sandboxPreview),
  "repair telemetry must include repair_source: runtime"
)

assert(
  "raw alias invariant exists after repair",
  /function assertNoRawAliasAfterRepair/.test(sandboxPreview) &&
    /assertNoRawAliasAfterRepair\(path, source,/.test(sandboxPreview),
  "runtime repair must validate that no raw alias remains"
)

assert(
  "generation quality gate is stage aware",
  /validateGenerationQualityGate\(files: GeneratedFile\[\], stage: GenerationStage = "expansion"\)/.test(generateRoute) &&
    /const shouldValidateImports = stage !== "scaffold"/.test(generateRoute),
  "scaffold stage should run relaxed validation and expansion should validate imports"
)

assert(
  "governance failures are separated from runtime errors",
  /errorCode:\s*isQualityGateError/.test(generateRoute) &&
    /GENERATION_INCOMPLETE_REPAIRING/.test(generateRoute),
  "generation governance failures need a distinct error code"
)

assert(
  "scaffold-first governance remains enabled",
  /const generationStage: GenerationStage/.test(generateRoute) &&
    /buildProjectFiles\(\{[\s\S]*providerMessage:\s*null/.test(generateRoute) &&
    /mergeGeneratedFiles\(scaffold\.files, providerParsed\.files\)/.test(generateRoute),
  "new generations should validate scaffold first and merge provider expansion onto it"
)

console.log("[regression] all checks passed")
