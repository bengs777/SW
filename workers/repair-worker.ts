export function createRepairWorker() {
  throw new Error("Standalone repair worker is disabled; repairs run only inside the canonical generation worker.")
}
