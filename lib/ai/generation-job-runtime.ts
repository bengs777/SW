const activeGenerationControllers = new Map<string, AbortController>()

export function registerGenerationAbortController(jobId: string, controller: AbortController) {
  activeGenerationControllers.set(jobId, controller)

  return () => {
    if (activeGenerationControllers.get(jobId) === controller) {
      activeGenerationControllers.delete(jobId)
    }
  }
}

export function abortGenerationJob(jobId: string) {
  const controller = activeGenerationControllers.get(jobId)
  if (!controller) return false

  controller.abort()
  activeGenerationControllers.delete(jobId)
  return true
}

