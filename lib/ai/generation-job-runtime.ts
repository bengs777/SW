const activeGenerationControllers = new Map<string, AbortController>()
const finalizingJobs = new Set<string>()

export function registerGenerationAbortController(jobId: string, controller: AbortController) {
  activeGenerationControllers.set(jobId, controller)

  return () => {
    if (activeGenerationControllers.get(jobId) === controller) {
      activeGenerationControllers.delete(jobId)
    }
    finalizingJobs.delete(jobId)
  }
}

export function markGenerationJobFinalizing(jobId: string) {
  finalizingJobs.add(jobId)
}

export function isGenerationJobFinalizing(jobId: string): boolean {
  return finalizingJobs.has(jobId)
}

export function abortGenerationJob(jobId: string) {
  if (finalizingJobs.has(jobId)) {
    return false
  }

  const controller = activeGenerationControllers.get(jobId)
  if (!controller) return false

  controller.abort()
  activeGenerationControllers.delete(jobId)
  return true
}

