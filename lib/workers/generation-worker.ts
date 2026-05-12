import type { Job } from "bullmq"
import { prisma } from "@/lib/db/client"
import { createGenerationWorker, type GenerationQueuePayload } from "@/lib/queue/generation-queue"
import { registerGenerationAbortController } from "@/lib/ai/generation-job-runtime"
import { executeGenerationJob } from "@/lib/services/generation-orchestrator.service"
import { GenerationJobCancelledError, GenerationJobService } from "@/lib/services/generation-job.service"
import { log } from "@/lib/logging"

async function loadProjectFiles(projectId: string) {
  const files = await prisma.projectFile.findMany({
    where: { projectId },
    orderBy: { path: "asc" },
  })

  return files.map((file) => ({
    path: file.path,
    content: file.content,
    language: file.language as
      | "tsx"
      | "ts"
      | "css"
      | "json"
      | "html"
      | "prisma"
      | "md"
      | "env",
  }))
}

export async function processGenerationQueueJob(job: Job<GenerationQueuePayload>) {
  const abortController = new AbortController()
  const unregisterAbort = registerGenerationAbortController(job.data.jobId, abortController)

  try {
    await executeGenerationJob(
      {
        jobId: job.data.jobId,
        projectId: job.data.projectId,
        prompt: job.data.prompt,
        selectedModel: job.data.model,
        promptLanguage: job.data.promptLanguage,
        collaborationMode: job.data.collaborationMode,
        signal: abortController.signal,
      },
      {
        loadProjectFiles,
      }
    )
  } catch (error) {
    if (!(error instanceof GenerationJobCancelledError)) {
      log("error", "Generation worker failed", {
        jobId: job.data.jobId,
        queueJobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    unregisterAbort()
  }
}

export function startGenerationWorker() {
  const worker = createGenerationWorker(processGenerationQueueJob)

  worker.on("active", async (job) => {
    if (!job) return
    await GenerationJobService.attachQueueJob(job.data.jobId, job.id || job.data.jobId)
  })

  worker.on("failed", async (job, error) => {
    if (!job) return
    if (error instanceof GenerationJobCancelledError) return
    await GenerationJobService.markFailed(job.data.jobId, error.message || "Generation worker failed")
  })

  worker.on("completed", async (job) => {
    if (!job) return
    log("info", "Generation worker completed", {
      jobId: job.data.jobId,
      queueJobId: job.id,
    })
  })

  return worker
}
