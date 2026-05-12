// Standalone Sandbox Worker
// Manages isolated preview runtimes for projects
/* eslint-disable @typescript-eslint/no-require-imports */

import type { Job, Worker as BullWorker } from "bullmq"
import type { GeneratedFile } from "@/lib/types"

type SandboxJobPayload = {
  type: "start" | "stop" | "reset"
  projectId: string
  files?: Array<{ path: string; content: string }>
}

declare global {
  var __swiftSandboxWorker: BullWorker<SandboxJobPayload> | undefined
}

export function createSandboxWorker(): BullWorker<SandboxJobPayload> {
  if (global.__swiftSandboxWorker) {
    return global.__swiftSandboxWorker
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRedisConnection } = require("./redis")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require("bullmq") as typeof import("bullmq")

  const connection = getRedisConnection()

  const worker = new Worker<SandboxJobPayload>(
    "swift:sandbox:v1",
    async (job: Job<SandboxJobPayload>) => {
      const { type, projectId, files } = job.data

      console.log(`[SandboxWorker] ${type} sandbox for project ${projectId}`)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { prisma } = require("../lib/db/client")

      try {
        // Load files from database if not provided
        let projectFiles = files ?? []
        if (projectFiles.length === 0) {
          const dbFiles = await prisma.projectFile.findMany({
            where: { projectId },
          })
          projectFiles = dbFiles.map((f: any) => ({
            path: f.path,
            content: f.content,
          }))
        }

        const typedFiles: GeneratedFile[] = projectFiles.map((f: any) => ({
          path: f.path,
          content: f.content,
          language: "tsx",
        }))

        switch (type) {
          case "start": {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { startRuntimeSandbox } = require("../lib/sandbox/runtime")
            const result = await startRuntimeSandbox(projectId, typedFiles)

            // Update project with preview URL
            await prisma.project.update({
              where: { id: projectId },
              data: { previewUrl: result.previewUrl ?? undefined },
            })

            console.log(`[SandboxWorker] Started sandbox for ${projectId}: ${result.previewUrl}`)
            return { success: true, previewUrl: result.previewUrl, error: result.error }
          }

          case "stop": {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resetRuntimeSandbox } = require("../lib/sandbox/runtime")
            await resetRuntimeSandbox(projectId)
            console.log(`[SandboxWorker] Stopped sandbox for ${projectId}`)
            return { success: true }
          }

          case "reset": {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resetRuntimeSandbox, startRuntimeSandbox } = require("../lib/sandbox/runtime")
            await resetRuntimeSandbox(projectId)
            const result = await startRuntimeSandbox(projectId, typedFiles)
            await prisma.project.update({
              where: { id: projectId },
              data: { previewUrl: result.previewUrl ?? undefined },
            })
            console.log(`[SandboxWorker] Reset sandbox for ${projectId}`)
            return { success: true, previewUrl: result.previewUrl, error: result.error }
          }

          default: {
            const _exhaustive: never = type
            throw new Error(`Unknown sandbox action: ${_exhaustive}`)
          }
        }
      } catch (error) {
        console.error(`[SandboxWorker] Failed for ${projectId}:`, error)
        throw error
      }
    },
    {
      connection,
      concurrency: Number(process.env.SWIFT_SANDBOX_WORKER_CONCURRENCY || 1),
      stalledInterval: 60000,
      lockDuration: 300000,
    }
  )

  worker.on("active", (job: Job<SandboxJobPayload>) => {
    console.log(`[SandboxWorker] Active: job ${job.id}`)
  })

  worker.on("completed", (job: Job<SandboxJobPayload>) => {
    console.log(`[SandboxWorker] Completed: job ${job.id}`)
  })

  worker.on("failed", (job: Job<SandboxJobPayload> | undefined, err: Error) => {
    console.error(`[SandboxWorker] Failed: job ${job?.id}`, err.message)
  })

  console.log("[SandboxWorker] Worker initialized and listening")
  global.__swiftSandboxWorker = worker
  return worker
}