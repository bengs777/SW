import type { GeneratedFile } from "@/lib/types"
import { resetRuntimeSandbox, startRuntimeSandbox } from "@/lib/sandbox/runtime"

export type DedicatedSandboxResult = Awaited<ReturnType<typeof startRuntimeSandbox>> & {
  sandboxOwnerKey: string
  changedFiles: string[]
}

export function dedicatedSandboxId(userId: string, projectId: string) {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "user"
  const safeProject = projectId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "project"
  return `${safeUser}-${safeProject}`
}

export async function runDedicatedUserSandbox(input: {
  userId: string
  projectId: string
  files: GeneratedFile[]
  changedFiles?: GeneratedFile[]
  signal?: AbortSignal
}): Promise<DedicatedSandboxResult> {
  const sandboxOwnerKey = dedicatedSandboxId(input.userId, input.projectId)
  const result = await startRuntimeSandbox(sandboxOwnerKey, input.files, { signal: input.signal })
  return {
    ...result,
    sandboxOwnerKey,
    changedFiles: (input.changedFiles || []).map((file) => file.path),
  }
}

export async function cleanupDedicatedUserSandbox(input: { userId: string; projectId: string }) {
  return resetRuntimeSandbox(dedicatedSandboxId(input.userId, input.projectId))
}
