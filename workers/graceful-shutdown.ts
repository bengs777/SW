// Graceful shutdown handler for standalone workers
// Handles SIGTERM/SIGINT with proper cleanup

import type { Worker } from "bullmq"

const workers: Worker[] = []

export function registerWorker(worker: Worker) {
  workers.push(worker)
  console.log(`[Shutdown] Registered worker: ${worker.name || worker.id || "unnamed"}`)
}

export function unregisterWorker(worker: Worker) {
  const index = workers.indexOf(worker)
  if (index > -1) {
    workers.splice(index, 1)
    console.log(`[Shutdown] Unregistered worker: ${worker.name || worker.id || "unnamed"}`)
  }
}

export async function gracefulShutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, initiating graceful shutdown...`)

  // Close all workers
  for (const worker of workers) {
    try {
      console.log(`[Shutdown] Closing worker...`)
      await worker.close()
    } catch (err) {
      console.error(`[Shutdown] Error closing worker:`, err)
    }
  }

  // Close Redis connections
  const globalForRedis = globalThis as unknown as {
    __swiftRedisClient?: { disconnect: () => Promise<void> }
  }

  if (globalForRedis.__swiftRedisClient) {
    try {
      await globalForRedis.__swiftRedisClient.disconnect()
      console.log("[Shutdown] Redis connection closed")
    } catch (err) {
      console.error("[Shutdown] Error disconnecting Redis:", err)
    }
  }

  console.log("[Shutdown] Graceful shutdown complete")
  process.exit(0)
}

// Register signal handlers
let handlersRegistered = false

export function setupShutdownHandlers() {
  if (handlersRegistered) return

  handlersRegistered = true

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))

  // Handle uncaught exceptions
  process.on("uncaughtException", (err) => {
    console.error("[Unhandled] Uncaught exception:", err)
    gracefulShutdown("uncaughtException")
  })

  process.on("unhandledRejection", (reason) => {
    console.error("[Unhandled] Unhandled rejection:", reason)
  })
}
