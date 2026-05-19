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

  const module = { exports: {} }
  moduleCache.set(absolute, module)

  const localRequire = (request) => {
    if (request === "@/lib/ai/canonical-path") return loadModule("lib/ai/canonical-path.ts")
    if (request === "@/lib/ai/file-policy") return loadModule("lib/ai/file-policy.ts")
    if (request === "@/lib/workspace-state") return loadModule("lib/workspace-state.ts")
    return require(request)
  }

  vm.runInNewContext(compiled, {
    Buffer,
    console,
    exports: module.exports,
    module,
    process,
    require: localRequire,
  }, { filename: file })

  return module.exports
}

function parseError(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const { parseGeneratedArtifact } = loadModule("lib/ai/generated-artifact.ts")
  const { SAFE_GENERATED_ROOT_FILES, validateGeneratedPath, formatGeneratedPathValidationError } =
    loadModule("lib/ai/file-policy.ts")

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

  console.log("[artifact-schema] artifact schema regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[artifact-schema] artifact schema regression checks failed")
  console.error(error)
  process.exit(1)
}
