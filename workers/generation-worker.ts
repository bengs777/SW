// Standalone Generation Worker
// Runs independently from Next.js, processes generation jobs from BullMQ
/* eslint-disable @typescript-eslint/no-require-imports */

import type { Job, Worker as BullWorker } from "bullmq"
import type { GeneratedFile } from "@/lib/types"
import { normalizeFileLanguage } from "@/lib/workspace-state"

type GenerationJobPayload = {
  jobId: string
  projectId: string
  prompt: string
  model: string
  provider: string
  userId: string
  promptLanguage?: "id" | "en"
  collaborationMode?: string
  idempotencyKey?: string
  abortSignal?: string
}

declare global {
  var __swiftGenerationWorker: BullWorker<GenerationJobPayload> | undefined
}

export function createGenerationWorker(): BullWorker<GenerationJobPayload> {
  // Return existing worker if already created
  if (global.__swiftGenerationWorker) {
    return global.__swiftGenerationWorker
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRedisConnection } = require("./redis")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require("bullmq") as typeof import("bullmq")

  const connection = getRedisConnection()

  const worker = new Worker<GenerationJobPayload>(
    "swift:generation:v2",
    async (job: Job<GenerationJobPayload>) => {
      const { jobId, projectId, prompt, promptLanguage = "id" } = job.data

      console.log(`[GenerationWorker] Starting job ${jobId} for project ${projectId}`)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { executeGenerationJob } = require("../lib/services/generation-orchestrator.service")
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GenerationJobService } = require("../lib/services/generation-job.service")
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { prisma } = require("../lib/db/client")

      try {
        // Load project files from database
        const loadProjectFiles = async (projectId: string): Promise<GeneratedFile[]> => {
          const files = await prisma.projectFile.findMany({
            where: { projectId },
            orderBy: { path: "asc" },
          })
          return files.map((file: any) => ({
            path: file.path,
            content: file.content,
            language: normalizeFileLanguage(file.language),
          }))
        }

        await executeGenerationJob(
          {
            jobId,
            projectId,
            prompt,
            selectedModel: job.data.model,
            promptLanguage,
            collaborationMode: job.data.collaborationMode,
          },
          {
            loadProjectFiles,
          }
        )

        console.log(`[GenerationWorker] Completed job ${jobId}`)
        return { success: true, jobId }
      } catch (error) {
        console.error(`[GenerationWorker] Failed job ${jobId}:`, error)

        try {
          await GenerationJobService.markFailed(
            jobId,
            error instanceof Error ? error.message : String(error)
          )
        } catch (dbErr) {
          console.error(`[GenerationWorker] Failed to update job status:`, dbErr)
        }

        throw error
      }
    },
    {
      connection,
      concurrency: Number(process.env.SWIFT_GENERATION_WORKER_CONCURRENCY || 2),
      stalledInterval: 30000,
      lockDuration: 120000,
    }
  )

  // Event handlers
  worker.on("active", (job: Job<GenerationJobPayload>) => {
    console.log(`[GenerationWorker] Active: job ${job.id}`)
  })

  worker.on("completed", (job: Job<GenerationJobPayload>) => {
    console.log(`[GenerationWorker] Completed: job ${job.id}`)
  })

  worker.on("failed", (job: Job<GenerationJobPayload> | undefined, err: Error) => {
    console.error(`[GenerationWorker] Failed: job ${job?.id}`, err.message)
  })

  console.log("[GenerationWorker] Worker initialized and listening")
  global.__swiftGenerationWorker = worker
  return worker
}