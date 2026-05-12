// Standalone Repair Worker
// Handles targeted repairs for failing code
/* eslint-disable @typescript-eslint/no-require-imports */

import type { Job, Worker as BullWorker } from "bullmq"
import type { GeneratedFile } from "@/lib/types"
import { normalizeFileLanguage } from "@/lib/workspace-state"

type RepairJobPayload = {
  jobId: string
  projectId: string
  failingFiles: string[]
  compileError: string
  prompt: string
  promptLanguage?: "id" | "en"
}

declare global {
  var __swiftRepairWorker: BullWorker<RepairJobPayload> | undefined
}

export function createRepairWorker(): BullWorker<RepairJobPayload> {
  if (global.__swiftRepairWorker) {
    return global.__swiftRepairWorker
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRedisConnection } = require("./redis")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require("bullmq") as typeof import("bullmq")

  const connection = getRedisConnection()

  const worker = new Worker<RepairJobPayload>(
    "swift:repair:v1",
    async (job: Job<RepairJobPayload>) => {
      const { jobId, projectId, failingFiles, compileError } = job.data

      console.log(`[RepairWorker] Starting repair for job ${jobId}, files: ${failingFiles.join(", ")}`)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { prisma } = require("../lib/db/client")

      try {
        // Load project files
        const existingFiles = await prisma.projectFile.findMany({
          where: { projectId },
          orderBy: { path: "asc" },
        })

        const mappedFiles: GeneratedFile[] = existingFiles.map((f: any) => ({
          path: f.path,
          content: f.content,
          language: normalizeFileLanguage(f.language),
        }))

        // Import AI modules dynamically
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProviderRouter } = require("../lib/ai/provider-router")
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { extractGeneratedFilesFromProviderMessage } = require("../lib/ai/provider-output")

        const failingFilesContent = mappedFiles
          .filter((f) => failingFiles.includes(f.path))
          .map((f) => `FILE ${f.path}\n${f.content}`)
          .join("\n\n")

        const repairPrompt = [
          `TASK: Fix the compilation error in the failing files.`,
          `ERROR: ${compileError}`,
          "",
          "TARGETED_REPAIR_ONLY:",
          "- Repair only the failing files listed below.",
          "- Do not regenerate the entire project.",
          "",
          "FAILING_FILES_CONTEXT:",
          failingFilesContent,
        ].join("\n")

        const response = await ProviderRouter.generate({
          provider: "openrouter",
          modelName: "anthropic/claude-3-5-sonnet-20241022",
          prompt: repairPrompt,
          mode: "files",
          promptLanguage: job.data.promptLanguage || "id",
        })

        const parsed = extractGeneratedFilesFromProviderMessage(response.message)

        if (parsed.files.length > 0) {
          // Update files in database
          for (const file of parsed.files) {
            await prisma.projectFile.upsert({
              where: {
                projectId_path: { projectId: projectId, path: file.path },
              },
              update: { content: file.content },
              create: {
                projectId,
                path: file.path,
                content: file.content,
                language: "tsx",
              },
            })
          }
        }

        console.log(`[RepairWorker] Completed repair for job ${jobId}`)
        return { success: true, repairedFiles: parsed.files.length }
      } catch (error) {
        console.error(`[RepairWorker] Failed repair for job ${jobId}:`, error)
        throw error
      }
    },
    {
      connection,
      concurrency: Number(process.env.SWIFT_REPAIR_WORKER_CONCURRENCY || 3),
      stalledInterval: 30000,
      lockDuration: 90000,
    }
  )

  worker.on("active", (job: Job<RepairJobPayload>) => {
    console.log(`[RepairWorker] Active: job ${job.id}`)
  })

  worker.on("completed", (job: Job<RepairJobPayload>) => {
    console.log(`[RepairWorker] Completed: job ${job.id}`)
  })

  worker.on("failed", (job: Job<RepairJobPayload> | undefined, err: Error) => {
    console.error(`[RepairWorker] Failed: job ${job?.id}`, err.message)
  })

  console.log("[RepairWorker] Worker initialized and listening")
  global.__swiftRepairWorker = worker
  return worker
}