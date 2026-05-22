const fs = require("node:fs")
const path = require("node:path")

const root = process.cwd()

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`[workspace-builder] ${name} failed${detail ? `: ${detail}` : ""}`)
  }
  console.log(`[workspace-builder] ${name} passed`)
}

function main() {
  const packageJson = JSON.parse(read("package.json"))
  const projectPage = read("app/dashboard/project/[id]/page.tsx")
  const commandCenter = read("components/editor/workspace-command-center.tsx")
  const header = read("components/editor/header.tsx")
  const historyRoute = read("app/api/projects/[id]/history/route.ts")
  const previewRoute = read("app/api/projects/[id]/validate-preview/route.ts")
  const githubRoute = read("app/api/projects/[id]/github/route.ts")
  const deployRoute = read("app/api/projects/[id]/deploy/route.ts")

  assert(
    "script.registered",
    packageJson.scripts && packageJson.scripts["test:workspace-builder"] === "node scripts/workspace-builder-regression.js",
    "package.json must expose npm run test:workspace-builder"
  )
  assert(
    "command-center.exists",
    /WorkspaceCommandCenter/.test(commandCenter) &&
      /Preview validation/.test(commandCenter) &&
      /Version history/.test(commandCenter) &&
      /Push GitHub/.test(commandCenter) &&
      /Deploy Vercel/.test(commandCenter),
    "workspace builder command center must expose validation, history, GitHub, and Vercel actions"
  )
  assert(
    "project-page.wired",
    /<WorkspaceCommandCenter/.test(projectPage) &&
      /onValidatePreview=\{handleValidatePreview\}/.test(projectPage) &&
      /onRollback=\{handleRollbackVersion\}/.test(projectPage) &&
      /onPushGitHub=\{handlePushToGitHub\}/.test(projectPage) &&
      /onDeployVercel=\{handleDeployToVercel\}/.test(projectPage),
    "editor page must wire workspace builder actions"
  )
  assert(
    "header.github-flow",
    /onPushGitHub\?:/.test(header) &&
      /isPushingGitHub\?:/.test(header) &&
      /Push to GitHub/.test(header),
    "header export menu must include the GitHub push flow"
  )
  assert(
    "history.rollback",
    /RollbackSchema/.test(historyRoute) &&
      /ProjectFilePersistenceService\.saveGenerationSnapshot/.test(historyRoute) &&
      /intent: "rollback"/.test(historyRoute),
    "history route must create a new snapshot when rolling back"
  )
  assert(
    "preview.validation",
    /validateRuntimeSyntax/.test(previewRoute) &&
      /validateRuntimeImports/.test(previewRoute) &&
      /compileProject/.test(previewRoute) &&
      /ok: syntax\.ok && imports\.ok && !compileError/.test(previewRoute),
    "preview validation route must run syntax, import, and preview compile checks"
  )
  assert(
    "github.deploy-flow",
    /GITHUB_TOKEN/.test(githubRoute) &&
      /SWIFT_GITHUB_TOKEN/.test(githubRoute) &&
      /git\/trees/.test(githubRoute) &&
      /git\/commits/.test(githubRoute) &&
      /setupRequired/.test(githubRoute),
    "GitHub flow must support configured pushes and clear setup-required failures"
  )
  assert(
    "vercel.deploy-existing",
    /api\.vercel\.com\/v13\/deployments/.test(deployRoute) &&
      /GenerationQualityService\.markLatestDeployOutcome/.test(deployRoute),
    "Vercel deploy route must remain wired to deployment API and quality metrics"
  )

  console.log("[workspace-builder] workspace builder regression checks passed")
}

try {
  main()
} catch (error) {
  console.error("[workspace-builder] workspace builder regression checks failed")
  console.error(error)
  process.exit(1)
}
