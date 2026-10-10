import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

/**
 * Process driver for the Swift sandbox runtime.
 *
 * - "host":   spawns npm directly on the machine (local development only).
 * - "docker": runs every command inside a throwaway, resource-limited container
 *             with the project directory mounted at /workspace.
 *
 * Production refuses the host driver unless SWIFT_SANDBOX_ALLOW_HOST_DRIVER=true,
 * because generated (untrusted) code would otherwise run with host privileges.
 */

const IS_PRODUCTION = process.env.NODE_ENV === "production"
const CONTAINER_WORKDIR = "/workspace"

// Host-specific variables that must never leak into (or break) a container.
const HOST_ONLY_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "SystemRoot",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
])

function resolveDriverName() {
  const configured = String(process.env.SWIFT_SANDBOX_DRIVER || "").trim().toLowerCase()
  const name = configured || (IS_PRODUCTION ? "docker" : "host")

  if (name !== "host" && name !== "docker") {
    throw new Error(`Unsupported SWIFT_SANDBOX_DRIVER: ${name}. Use "host" or "docker".`)
  }

  if (name === "host" && IS_PRODUCTION && process.env.SWIFT_SANDBOX_ALLOW_HOST_DRIVER !== "true") {
    throw new Error(
      "SWIFT_SANDBOX_DRIVER=host is blocked in production. Use the docker driver or set SWIFT_SANDBOX_ALLOW_HOST_DRIVER=true explicitly."
    )
  }

  return name
}

function dockerConfig() {
  return {
    image: process.env.SWIFT_SANDBOX_DOCKER_IMAGE || "node:22-bookworm-slim",
    cpus: process.env.SWIFT_SANDBOX_DOCKER_CPUS || "1",
    memory: process.env.SWIFT_SANDBOX_DOCKER_MEMORY || "1536m",
    pidsLimit: process.env.SWIFT_SANDBOX_DOCKER_PIDS_LIMIT || "512",
    tmpfsSize: process.env.SWIFT_SANDBOX_DOCKER_TMPFS_SIZE || "256m",
    user: process.env.SWIFT_SANDBOX_DOCKER_USER || "1000:1000",
    network: process.env.SWIFT_SANDBOX_DOCKER_NETWORK || "bridge",
    // Optional hardened runtime, e.g. "runsc" for gVisor.
    runtime: process.env.SWIFT_SANDBOX_DOCKER_RUNTIME || "",
  }
}

function containerName(state, role) {
  const digest = createHash("sha1").update(`${state.projectId}:${role}`).digest("hex").slice(0, 16)
  return `swift-sbx-${role}-${digest}`
}

function hostDriver() {
  return {
    name: "host",
    devHostname: "127.0.0.1",
    spawn(state, command, args, options = {}) {
      return spawn(command, args, {
        cwd: state.rootDir,
        env: options.env,
        shell: false,
      })
    },
    terminate(child) {
      if (child && !child.killed) child.kill()
    },
    describe() {
      return { driver: "host", isolated: false }
    },
  }
}

function dockerDriver() {
  const config = dockerConfig()

  return {
    name: "docker",
    devHostname: "0.0.0.0",
    spawn(state, command, args, options = {}) {
      const role = options.role || "task"
      const name = containerName(state, role)
      const env = options.env || {}
      const forwardedEnv = Object.entries(env).filter(
        ([key, value]) => !HOST_ONLY_ENV_KEYS.has(key) && value !== undefined && value !== null && value !== ""
      )

      // Remove any leftover container with the same name (e.g. after a crash).
      spawn("docker", ["rm", "-f", name], { stdio: "ignore", shell: false }).on("error", () => {})

      const dockerArgs = [
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        "--label",
        "swift.sandbox=1",
        "--label",
        `swift.project=${String(state.projectId).slice(0, 120)}`,
        "--cpus",
        config.cpus,
        "--memory",
        config.memory,
        "--memory-swap",
        config.memory,
        "--pids-limit",
        config.pidsLimit,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--network",
        config.network,
        "--tmpfs",
        `/tmp:rw,nosuid,size=${config.tmpfsSize}`,
        "--user",
        config.user,
        "-v",
        `${state.rootDir}:${CONTAINER_WORKDIR}`,
        "-w",
        CONTAINER_WORKDIR,
        "-e",
        "HOME=/tmp",
        "-e",
        "NEXT_TELEMETRY_DISABLED=1",
      ]

      if (config.runtime) {
        dockerArgs.push("--runtime", config.runtime)
      }

      if (options.publishPort) {
        // Bind only to loopback; the sandbox proxy is the single public entrypoint.
        dockerArgs.push("-p", `127.0.0.1:${options.publishPort}:${options.publishPort}`)
      }

      // Pass values through the child env (not argv) so secrets never appear in `ps`.
      for (const [key] of forwardedEnv) {
        dockerArgs.push("-e", key)
      }

      dockerArgs.push(config.image, command, ...args)

      const child = spawn("docker", dockerArgs, {
        cwd: state.rootDir,
        env: { ...process.env, ...Object.fromEntries(forwardedEnv) },
        shell: false,
      })
      child.containerName = name
      return child
    },
    terminate(child) {
      if (!child) return
      if (child.containerName) {
        spawn("docker", ["rm", "-f", child.containerName], { stdio: "ignore", shell: false }).on("error", () => {})
      }
      if (!child.killed) child.kill()
    },
    describe() {
      return {
        driver: "docker",
        isolated: true,
        image: config.image,
        cpus: config.cpus,
        memory: config.memory,
        network: config.network,
        runtime: config.runtime || "runc",
      }
    },
  }
}

export function createProcessDriver() {
  return resolveDriverName() === "docker" ? dockerDriver() : hostDriver()
}
