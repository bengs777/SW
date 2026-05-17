const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, pass, detail) {
  if (!pass) {
    const error = new Error(`${name}: ${detail}`)
    error.name = "HardeningRegressionError"
    throw error
  }
  console.log(`PASS ${name} - ${detail}`)
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const filesystemService = read("lib/services/project-filesystem.service.ts")
  const persistenceService = read("lib/services/project-file-persistence.service.ts")
  const orchestrator = read("lib/services/generation-orchestrator.service.ts")
  const projectApi = read("app/api/projects/[id]/route.ts")
  const projectPage = read("app/dashboard/project/[id]/page.tsx")
  const artifactParser = read("lib/ai/generated-artifact.ts")
  const taskGraphExecutor = read("lib/ai/task-graph-executor.ts")
  const generationPipeline = read("lib/ai/generation-pipeline.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:hardening"] === "node scripts/pipeline-hardening-regression.js",
    "package.json exposes npm run test:hardening"
  )

  assert(
    "filesystem.canonical-service",
    /class ProjectFilesystemService/.test(filesystemService) &&
      /readFiles\(/.test(filesystemService) &&
      /writeBatch\(/.test(filesystemService) &&
      /replaceFiles\(/.test(filesystemService) &&
      /verify\(/.test(filesystemService),
    "ProjectFilesystemService owns read/write/verify"
  )

  assert(
    "manifest.content-hash",
    /contentHash\s*=\s*createHash\("sha256"\)\.update\(content\)/.test(filesystemService) &&
      /fileHashes\[file\.path\]\s*=\s*fileHash/.test(filesystemService) &&
      /hash\.update\(fileHash\)/.test(filesystemService),
    "manifest hashes file content hashes, not metadata only"
  )

  assert(
    "manifest.stable-order",
    /sort\(\(left,\s*right\)\s*=>\s*left\.path\.localeCompare\(right\.path\)\)/.test(filesystemService),
    "manifest input is sorted by path before hashing"
  )

  assert(
    "explorer.api-source-of-truth",
    /ProjectFilesystemService\.readFiles\(id\)/.test(projectApi) &&
      /fileState:\s*\{[\s\S]*manifest/.test(projectApi),
    "project API reads canonical filesystem and returns manifest"
  )

  assert(
    "sse.refresh-only",
    /source !== "persisted"/.test(projectPage) &&
      /refreshProjectState\("filesystem-persisted"\)/.test(projectPage) &&
      !/setGeneratedFiles\(\(currentFiles\)[\s\S]*streamed_files_applied/.test(projectPage),
    "Explorer ignores streamed file payloads and refreshes API after persisted event"
  )

  assert(
    "path.allowed-roots",
    /ALLOWED_ROOTS\s*=\s*\["app\/",\s*"components\/",\s*"lib\/",\s*"prisma\/",\s*"public\/"\]/.test(filesystemService) &&
      /Generated file path is outside allowed project roots/.test(filesystemService) &&
      /Generated file path is outside allowed project roots/.test(taskGraphExecutor),
    "filesystem and executor reject paths outside project roots"
  )

  assert(
    "taskgraph.semantic-collapse",
    /function collapseOperations/.test(taskGraphExecutor) &&
      /createdPaths\.has\(path\)\s*\|\|\s*previous\?\.action === "create"/.test(taskGraphExecutor) &&
      /\?\s*"create"\s*:\s*operation\.action/.test(taskGraphExecutor),
    "create+modify collapses to create(finalContent)"
  )

  assert(
    "dependency.allowlist",
    /export const PACKAGE_VERSION_ALLOWLIST/.test(generationPipeline) &&
      /PACKAGE_VERSION_ALLOWLIST\[parsed\.name\]/.test(taskGraphExecutor) &&
      /Dependency is not allowed by Swift policy/.test(taskGraphExecutor) &&
      !/parsed\.version\s*\|\|\s*"latest"/.test(taskGraphExecutor),
    "TaskGraph dependency installer uses allowlist versions only"
  )

  assert(
    "resource.limits",
    /MAX_OPERATIONS\s*=\s*100/.test(taskGraphExecutor) &&
      /MAX_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/.test(taskGraphExecutor) &&
      /MAX_FILE_BYTES\s*=\s*200\s*\*\s*1024/.test(taskGraphExecutor) &&
      /MAX_PROJECT_FILES\s*=\s*100/.test(filesystemService) &&
      /MAX_SINGLE_FILE_BYTES\s*=\s*200\s*\*\s*1024/.test(artifactParser),
    "parser, executor, and filesystem enforce operation/file/byte limits"
  )

  assert(
    "stale-generation.guard",
    /pg_advisory_xact_lock\(hashtext/.test(persistenceService) &&
      /assertLatestProjectGeneration/.test(persistenceService) &&
      /createdAt:\s*\{\s*gt:\s*currentJob\.createdAt\s*\}/.test(persistenceService) &&
      /StaleGenerationRejected/.test(persistenceService) &&
      /generationJobId:\s*input\.jobId/.test(orchestrator),
    "persistence rejects older jobs when newer project generation exists"
  )

  assert(
    "json.fragment-parser",
    /extractJsonFragments/.test(artifactParser) &&
      /```\(\?:json\)\?/.test(artifactParser) &&
      /value\.slice\(firstObject,\s*lastObject\s*\+\s*1\)/.test(artifactParser),
    "AI JSON parser accepts fenced or text-wrapped JSON fragments"
  )

  console.log("\n[hardening] pipeline hardening regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("\n[hardening] pipeline hardening regression checks failed")
  console.error(error)
  process.exit(1)
}
