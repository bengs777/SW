const fs = require("node:fs")
const path = require("node:path")

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}

  const env = {}
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const separatorIndex = line.indexOf("=")
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    if (!key) continue

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    env[key] = value
  }

  return env
}

const root = __dirname
const fileEnv = loadEnvFile(path.join(root, ".env"))
const sandboxEnv = loadEnvFile(path.join(root, ".env.sandbox"))

module.exports = {
  apps: [
    {
      name: "swift-generation-worker",
      cwd: root,
      script: "scripts/run-ts-script.js",
      args: "workers/index.ts --type=generation",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 30000,
      env: {
        ...fileEnv,
        NODE_ENV: "production",
        SWIFT_WORKER_TYPE: "generation",
        SWIFT_GENERATION_EXECUTION_MODE: "queue",
        SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK: "true",
        SWIFT_WORKER_HEALTH_PORT: "4000",
        PORT: "4000",
      },
    },
    {
      name: "swift-sandbox",
      cwd: path.join(root, "services", "sandbox-runtime"),
      script: "server.mjs",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 30000,
      env: {
        ...fileEnv,
        ...sandboxEnv,
        NODE_ENV: "production",
        PORT: "8080",
        HOST: "0.0.0.0",
        SANDBOX_PUBLIC_BASE_URL: sandboxEnv.SANDBOX_PUBLIC_BASE_URL || "https://sandbox.ai-swift.biz.id",
        SWIFT_SANDBOX_ROOT: sandboxEnv.SWIFT_SANDBOX_ROOT || "/data/swift-sandbox",
      },
    },
  ],
}
