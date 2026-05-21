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
const generationOrchestrator = read("lib/services/generation-orchestrator.service.ts")
const sandboxRuntime = read("lib/sandbox/runtime.ts")
const generationJobService = read("lib/services/generation-job.service.ts")
const generationJobStream = read("app/api/generate/jobs/[jobId]/stream/route.ts")
const projectPage = read("app/dashboard/project/[id]/page.tsx")
const developerDiagnostics = read("lib/ai/developer-diagnostics.ts")

assert(
  "runtime repair uses virtual boundary import",
  sandboxPreview.includes('injectVirtualModuleImport(') &&
    sandboxPreview.includes("/@preview/components/swift-safe-error-boundary.tsx"),
  "runtime repair must inject a virtual module specifier, not a raw alias"
)

assert(
  "browser preview loads tailwind runtime",
  sandboxPreview.includes("https://cdn.tailwindcss.com") &&
    sandboxPreview.includes("window.tailwind.config") &&
    /script-src[^"]*https:\/\/cdn\.tailwindcss\.com/.test(sandboxPreview),
  "browser preview must generate Tailwind utility CSS inside the iframe"
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
  "post-babel boundary repair precedes alias assertion",
  /var repairedCode = rewriteStaleErrorBoundaryReferences\(path, result\.code, 'post-babel'\);\s*assertNoUnresolvedAlias\(path, repairedCode, 'post-babel:post-repair'\)/.test(sandboxPreview),
  "post-babel generated boundary imports must be repaired before unresolved alias validation"
)

assert(
  "deterministic validation lifecycle exists",
  /async function runValidationLifecycle/.test(generationOrchestrator) &&
    /Normalizing generated artifacts/.test(generationOrchestrator) &&
    /Checking static project invariants/.test(generationOrchestrator) &&
    /Compiling preview module graph/.test(generationOrchestrator) &&
    /Running typecheck, lint, and production build/.test(generationOrchestrator),
  "orchestrator must run normalize -> static validation -> preview compile -> typecheck/lint/build"
)

assert(
  "validation failure blocks persistence",
  /if \(!validation\.ok\)[\s\S]*throw new Error\(validation\.failure\?\.message/.test(generationOrchestrator) &&
    /ProjectFilePersistenceService\.saveBufferedArtifacts/.test(generationOrchestrator) &&
    generationOrchestrator.indexOf("if (!validation.ok)") < generationOrchestrator.indexOf("ProjectFilePersistenceService.saveBufferedArtifacts"),
  "invalid artifacts must fail before saveBufferedArtifacts"
)

assert(
  "explicit fullstack uses production mode",
    /productionMode:\s*"preview"\s*\|\s*"production_fullstack"/.test(generationOrchestrator) &&
    /shouldUseProductionFullStackMode/.test(generationOrchestrator) &&
    /PRODUCTION_FULLSTACK_FILE_LIMIT\s*=\s*16/.test(generationOrchestrator) &&
    /buildFastClinicFullStackScaffold/.test(generationOrchestrator) &&
    /Production pass budget/.test(generationOrchestrator),
  "full-stack/admin/database/payment prompts must use a compact production core instead of the 3-file preview contract"
)

assert(
  "production fullstack requires full coverage",
  /input\.plan\.productionMode !== "production_fullstack"[\s\S]*isPreviewFoundationPass/.test(generationOrchestrator) &&
    /requiresFullStackCoverage && fullstack\.missingCategories/.test(generationOrchestrator),
  "production full-stack mode must require frontend, API, data, and config coverage"
)

assert(
  "repair retry is bounded and revalidated",
  /while \(!validation\.ok && repairAttempt < MAX_REPAIR_ATTEMPTS\)/.test(generationOrchestrator) &&
    /Revalidating repaired artifacts/.test(generationOrchestrator) &&
    /repairAttempt \+= 1/.test(generationOrchestrator),
  "repair loop must be capped and must re-run validation after each repair"
)

assert(
  "sandbox gates typecheck lint and build",
  /npm", \["run", "typecheck"\]/.test(sandboxRuntime) &&
    /npm", \["run", "db:generate"\]/.test(sandboxRuntime) &&
    /SWIFT_SANDBOX_LINT_POLICY/.test(sandboxRuntime) &&
    /npm", \["run", "build"\]/.test(sandboxRuntime) &&
    /policy: "required"[\s\S]*command: "npm run build"/.test(sandboxRuntime),
  "sandbox must typecheck, define lint policy, and require production build before preview"
)

assert(
  "job transitions lock terminal and cancelling states",
  /GENERATION_TERMINAL_STATUSES\.has\(existing\.status\)/.test(generationJobService) &&
    /existing\.cancelRequested/.test(generationJobService) &&
    /requestedStatus !== "cancelled"/.test(generationJobService),
  "late completion/failure must not overwrite terminal or cancellation-locked jobs"
)

assert(
  "developer diagnostics are gated",
  /developerDiagnosticsAllowed/.test(generationJobStream) &&
    /isDeveloperAccount/.test(generationJobStream) &&
    /process\.env\.NODE_ENV !== "production"/.test(generationJobStream) &&
    /send\("developer\.diagnostics"/.test(generationJobStream),
  "developer diagnostics SSE payloads must only be sent to developer/local users"
)

assert(
  "developer diagnostics panel wired",
  /DeveloperDiagnosticsPanel/.test(projectPage) &&
    /developer\.diagnostics/.test(projectPage) &&
    /showDeveloperDiagnostics/.test(projectPage),
  "project UI must expose expandable diagnostics only when developer payloads arrive"
)

assert(
  "repair introspection captures failed artifacts",
  /persistInvalidArtifactReport/.test(generationOrchestrator) &&
    /\.swift-reports", "failed-generations"/.test(developerDiagnostics) &&
    /repairPromptPreview/.test(generationOrchestrator) &&
    /validatorResult/.test(generationOrchestrator),
  "orchestrator must capture invalid artifacts and repair-chain details"
)

assert(
  "builder scope contract blocks implicit helpers",
  /AllowedFileScopeContract/.test(generationOrchestrator) &&
    /APPROVED_FILE_SCOPE_CONTRACT/.test(generationOrchestrator) &&
    /components\/app-shell\.tsx/.test(generationOrchestrator) &&
    /isImplicitHelperFile/.test(generationOrchestrator) &&
    /scopeArtifactToAllowedScope\(parsed, input\.plan\)/.test(generationOrchestrator),
  "builder and repair must share an explicit allowed-file contract and block unapproved helper files"
)

console.log("[regression] all checks passed")
