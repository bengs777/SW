export function createSandboxWorker() {
  throw new Error("Standalone sandbox worker is disabled; sandbox execution is invoked by the canonical generation worker or sandbox API.")
}
