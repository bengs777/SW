const { execSync } = require("child_process")

function run(label, command, options = {}) {
  console.log(`\n[demo-readiness] ${label}`)
  try {
    execSync(command, {
      stdio: "inherit",
      env: { ...process.env, ...(options.env || {}) },
    })
    console.log(`[demo-readiness] ${label} passed`)
    return true
  } catch (error) {
    console.error(`[demo-readiness] ${label} failed`)
    if (error && error.status !== undefined) {
      console.error(`[demo-readiness] exit status: ${error.status}`)
    }
    if (options.optional) {
      console.error(`[demo-readiness] ${label} is optional for local demo readiness: ${options.reason || "not configured"}`)
      return true
    }
    return false
  }
}

const checks = [
  run("preview regression guards", "npm run test:regression"),
  run("typecheck", "npm run typecheck"),
  run("lint", "npm run lint"),
]

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
  checks.push(run("production audit", "npm run audit:production"))
} else {
  checks.push(
    run("production audit", "npm run audit:production", {
      optional: true,
      reason: "DATABASE_URL is required for the production build command",
    })
  )
}

const ok = checks.every(Boolean)

console.log("\n[demo-readiness] summary")
console.log(ok ? "[demo-readiness] READY_FOR_DEMO" : "[demo-readiness] NOT_READY")

if (!ok) {
  process.exitCode = 1
}
