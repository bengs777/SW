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
    throw new Error(`[artifact-schema] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[artifact-schema] ${name} passed`)
}

function loadModule(file) {
  const absolute = path.join(root, file)
  if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports

  const source = read(file)
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const loadedModule = { exports: {} }
  moduleCache.set(absolute, loadedModule)

  const localRequire = (request) => {
    if (request === "@/lib/ai/canonical-path") return loadModule("lib/ai/canonical-path.ts")
    if (request === "@/lib/ai/file-policy") return loadModule("lib/ai/file-policy.ts")
    if (request === "@/lib/ai/runtime-contracts") return loadModule("lib/ai/runtime-contracts.ts")
    if (request === "@/lib/workspace-state") return loadModule("lib/workspace-state.ts")
    if (request === "@/lib/types") return {}
    return require(request)
  }

  vm.runInNewContext(compiled, {
    Buffer,
    console,
    exports: loadedModule.exports,
    module: loadedModule,
    process,
    require: localRequire,
  }, { filename: file })

  return loadedModule.exports
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const projectPage = read("app/dashboard/project/[id]/page.tsx")
  const {
    buildArtifactContractRepairInstructions,
    parseGeneratedArtifact,
    summarizeArtifactContractError,
  } = loadModule("lib/ai/generated-artifact.ts")
  const {
    parseRuntimeMessage,
    publicGenerationRuntimeErrorMessage,
    publicGenerationStructureErrorMessage,
  } = loadModule("lib/ai/runtime-contracts.ts")
  const { SAFE_GENERATED_ROOT_FILES, validateGeneratedPath, formatGeneratedPathValidationError } =
    loadModule("lib/ai/file-policy.ts")
  const { buildPreviewModuleGraph } = loadModule("lib/preview/module-resolution.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:artifact-schema"] === "node scripts/artifact-schema-regression.js",
    "package.json exposes npm run test:artifact-schema"
  )

  const packageArtifact = parseGeneratedArtifact(JSON.stringify({
    files: [{ kind: "file", path: "package.json", language: "json", content: "{}" }],
    dependencies: [],
    commands: [],
    summary: "package file",
    diagnostics: [],
    metadata: {},
    repairs: [],
  }))
  assert("package-json.allowed", packageArtifact.files[0].path === "package.json", "package.json is a safe root file")

  const envExample = validateGeneratedPath(".env.example")
  assert("env-example.allowed", envExample.path === ".env.example", ".env.example is an explicitly safe root file")

  const metadataArtifact = parseGeneratedArtifact(JSON.stringify({
    framework: "Next.js",
    files: [{ path: "app/page.tsx", language: "tsx", content: "export default function Page(){return null}" }],
    dependencies: [],
    commands: [],
    summary: "framework metadata",
    diagnostics: [],
    metadata: { frameworks: ["React", "TypeScript"] },
    repairs: [],
  }))
  assert(
    "framework.metadata-ignored",
    metadataArtifact.metadata.framework === "Next.js" && metadataArtifact.files[0].path === "app/page.tsx",
    "framework labels stay in metadata and do not enter path validation"
  )

  const dependencyArtifact = parseGeneratedArtifact(JSON.stringify({
    files: [{ path: "app/page.tsx", content: "export default function Page(){return null}" }],
    dependencies: ["next", "react", "@radix-ui/react-dialog"],
    commands: [],
    summary: "dependency metadata",
    diagnostics: [],
    metadata: {},
    repairs: [],
  }))
  assert(
    "dependencies.not-paths",
    dependencyArtifact.dependencies.includes("next") && dependencyArtifact.files[0].path === "app/page.tsx",
    "dependency names are classified separately from filesystem writes"
  )

  let commandError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      files: [{ path: "app/page.tsx", content: "export default function Page(){return null}" }],
      dependencies: [],
      commands: [{ kind: "runtime_command", label: "Next.js", command: "npm", args: ["run", "build"] }],
      summary: "command metadata",
      diagnostics: [],
      metadata: {},
      repairs: [],
    }))
  } catch (error) {
    commandError = error
  }
  assert(
    "command-labels.not-paths",
    commandError &&
      /commands/.test(commandError.message) &&
      !/PATH_ERROR/.test(commandError.message) &&
      !/"received":"Next\.js"/.test(commandError.message),
    "runtime command labels are rejected as commands, not validated as paths"
  )

  for (const blocked of [".env", ".git", "node_modules", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    let diagnostic = null
    try {
      validateGeneratedPath(blocked)
    } catch (error) {
      diagnostic = formatGeneratedPathValidationError(error)
    }
    assert(`blocked.${blocked}`, diagnostic && diagnostic.error === "PATH_ERROR", `${blocked} remains blocked`)
  }

  let rootDiagnostic = null
  try {
    validateGeneratedPath("vite.config.ts")
  } catch (error) {
    rootDiagnostic = formatGeneratedPathValidationError(error)
  }
  assert(
    "diagnostics.allowed-root-files",
    rootDiagnostic &&
      rootDiagnostic.reason === "Root file not allowlisted" &&
      Array.isArray(rootDiagnostic.allowedRootFiles) &&
      rootDiagnostic.allowedRootFiles.includes("package.json") &&
      SAFE_GENERATED_ROOT_FILES.includes("package.json"),
    "root-file diagnostics include the safe root allowlist"
  )

  let diagnosticPayloadError = null
  const diagnosticPayload = {
    error: "PATH_ERROR",
    reason: "Root file not allowlisted",
    received: "vite.config.ts",
    allowedRootFiles: SAFE_GENERATED_ROOT_FILES,
  }
  try {
    parseGeneratedArtifact(JSON.stringify(diagnosticPayload))
  } catch (error) {
    diagnosticPayloadError = error
  }
  assert(
    "diagnostic.isolation",
    diagnosticPayloadError &&
      /MALFORMED_GENERATED_ARTIFACT:(runtime-message:diagnostic|diagnostic-payload)/.test(diagnosticPayloadError.message) &&
      !/Unrecognized key\(s\).*reason/.test(diagnosticPayloadError.message),
    "validator diagnostics are identified before strict artifact parsing"
  )

  let blockedEnvArtifactError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      files: [{ path: ".env.production", content: "SECRET=value" }],
      dependencies: [],
      commands: [],
      summary: "blocked env",
      diagnostics: [],
      metadata: {},
      repairs: [],
    }))
  } catch (error) {
    blockedEnvArtifactError = error
  }
  const blockedEnvDiagnostic = summarizeArtifactContractError(blockedEnvArtifactError, {
    rawLength: 128,
    rawHash: "blocked-env-hash",
    requiredFiles: ["app/page.tsx"],
  })
  assert(
    "contract-diagnostics.path-error",
    blockedEnvDiagnostic.code === "PATH_ERROR" &&
      blockedEnvDiagnostic.category === "path_policy" &&
      blockedEnvDiagnostic.received === ".env.production" &&
      /Blocked path pattern not allowed/.test(blockedEnvDiagnostic.reason),
    "path policy failures keep safe structured diagnostics for repair"
  )

  let emptyFilesError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      files: [],
      dependencies: [],
      commands: [],
      summary: "empty",
      diagnostics: [],
      metadata: {},
      repairs: [],
    }))
  } catch (error) {
    emptyFilesError = error
  }
  const emptyFilesDiagnostic = summarizeArtifactContractError(emptyFilesError)
  assert(
    "contract-diagnostics.empty-files",
    emptyFilesDiagnostic.code === "MALFORMED_GENERATED_ARTIFACT" &&
      emptyFilesDiagnostic.category === "empty_files",
    "empty files arrays are classified for targeted repair"
  )

  let missingRequiredError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      files: [{ path: "app/page.tsx", content: "export default function Page(){return null}" }],
      dependencies: [],
      commands: [],
      summary: "missing admin",
      diagnostics: [],
      metadata: {},
      repairs: [],
    }), { requiredFiles: ["app/page.tsx", "app/admin/page.tsx"] })
  } catch (error) {
    missingRequiredError = error
  }
  const missingRequiredDiagnostic = summarizeArtifactContractError(missingRequiredError)
  const repairInstructionBlock = buildArtifactContractRepairInstructions(missingRequiredDiagnostic, {
    outputMode: "taskGraph",
    target: "app/admin/page.tsx",
    requiredFiles: ["app/admin/page.tsx"],
    allowedPaths: ["app/admin/page.tsx"],
    maxChangedFiles: 1,
  })
  assert(
    "contract-repair.instructions",
    missingRequiredDiagnostic.category === "missing_required_file" &&
      missingRequiredDiagnostic.missingFiles.includes("app/admin/page.tsx") &&
      /ARTIFACT_CONTRACT_REPAIR/.test(repairInstructionBlock) &&
      /taskGraph envelope/.test(repairInstructionBlock) &&
      /Allowed generated roots/.test(repairInstructionBlock) &&
      /Required files for this slice: app\/admin\/page\.tsx/.test(repairInstructionBlock),
    "repair prompt receives actionable validator details"
  )

  let strictUnknownError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      files: [{ path: "app/page.tsx", content: "export default function Page(){return null}" }],
      dependencies: [],
      commands: [],
      summary: "extra field",
      diagnostics: [],
      metadata: {},
      repairs: [],
      reason: "not allowed in artifact schema",
    }))
  } catch (error) {
    strictUnknownError = error
  }
  assert(
    "artifact.strict-unknown-fields",
    strictUnknownError && /Unrecognized key\(s\).*reason/.test(strictUnknownError.message),
    "artifact schemas still reject unknown artifact fields"
  )

  let mixedPayloadError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      kind: "diagnostic",
      data: diagnosticPayload,
      files: [{ path: "app/page.tsx", content: "export default function Page(){return null}" }],
    }))
  } catch (error) {
    mixedPayloadError = error
  }
  assert(
    "mixed-payload.rejected",
    mixedPayloadError && /MALFORMED_GENERATED_ARTIFACT:runtime-message:diagnostic/.test(mixedPayloadError.message),
    "mixed runtime diagnostic/artifact payloads are rejected"
  )

  const telemetryMessage = parseRuntimeMessage({
    kind: "telemetry",
    data: { event: "generation.validation", stage: "validate", durationMs: 12, reason: "metadata allowed" },
  })
  let telemetryArtifactError = null
  try {
    parseGeneratedArtifact(JSON.stringify({
      kind: "telemetry",
      data: { event: "generation.validation", stage: "validate", durationMs: 12 },
    }))
  } catch (error) {
    telemetryArtifactError = error
  }
  assert(
    "telemetry.isolation",
    telemetryMessage &&
      telemetryMessage.kind === "telemetry" &&
      telemetryArtifactError &&
      /MALFORMED_GENERATED_ARTIFACT:runtime-message:telemetry/.test(telemetryArtifactError.message),
    "runtime telemetry is parsed separately and never accepted as an artifact"
  )

  assert(
    "repair-loop.diagnostic-routing",
    /publicGenerationRuntimeErrorMessage/.test(orchestrator) &&
      /generation_slice_parse_retry/.test(orchestrator) &&
      /Repairing validation failure/.test(orchestrator) &&
      /artifact_parse_failed/.test(orchestrator) &&
      /artifact_path_validation_failed/.test(orchestrator) &&
      /artifact_contract_repair_started/.test(orchestrator),
    "orchestrator routes parser diagnostics to retry/repair flow"
  )

  assert(
    "repair-loop.stream-events",
    /type:\s*"artifact_validating"/.test(orchestrator) &&
      /type:\s*"artifact_invalid"/.test(orchestrator) &&
      /type:\s*"artifact_repairing"/.test(orchestrator) &&
      /type:\s*"artifact_repaired"/.test(orchestrator) &&
      /type:\s*"artifact_repair_failed"/.test(orchestrator),
    "job stream exposes artifact contract repair lifecycle"
  )

  assert(
    "frontend.public-schema-error",
    /publicGenerationRuntimeErrorMessage/.test(projectPage) &&
      publicGenerationStructureErrorMessage(new Error("MALFORMED_GENERATED_ARTIFACT:schema:artifact: Unrecognized key(s) in object: 'reason'")) ===
        "AI generated invalid project structure. Repair loop attempting automatic correction...",
    "frontend and shared helper hide raw schema dumps"
  )

  assert(
    "frontend.public-runtime-error",
    /publicGenerationRuntimeErrorMessage/.test(projectPage) &&
      publicGenerationRuntimeErrorMessage(new Error("Sandbox storage exhausted before installing dependencies: available 0B, required 256MB.")) !==
        "AI generated invalid project structure. Repair loop attempting automatic correction..." &&
      /Sandbox storage penuh/.test(publicGenerationRuntimeErrorMessage(new Error("Sandbox storage exhausted before installing dependencies: available 0B, required 256MB."))) &&
      /Swift production sedang menunggu dedicated worker/.test(publicGenerationRuntimeErrorMessage(new Error("GENERATION_WORKER_HEARTBEAT missing"))) &&
      /Swift queue belum siap/.test(publicGenerationRuntimeErrorMessage(new Error("Generation queue unavailable"))),
    "frontend and orchestrator distinguish sandbox, worker, queue, and artifact failures"
  )

  const nextLinkPreviewGraph = buildPreviewModuleGraph([
    {
      path: "app/page.tsx",
      language: "tsx",
      content:
        'import Link from "next/link"; export default function Page(){ return <Link href="/about">About</Link> }',
    },
  ])
  assert(
    "preview.next-link-shim",
    Boolean(nextLinkPreviewGraph.shims["next/link"]) && !nextLinkPreviewGraph.importMap["next/link"],
    "Next Link is served by the browser preview shim instead of the external package allowlist"
  )

  console.log("[artifact-schema] artifact schema regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[artifact-schema] artifact schema regression checks failed")
  console.error(error)
  process.exit(1)
}
