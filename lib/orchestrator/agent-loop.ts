import { ProviderRouter } from "@/lib/ai/provider-router"
import type { ProviderName } from "@/lib/ai/provider-router"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import { chooseModelForTask } from "@/lib/ai/model-router"
import { buildContextForTask } from "@/lib/ai/context-builder"
import * as Executor from "@/lib/orchestrator/executor"
import type { GeneratedFile } from "@/lib/types"
import type { OrchestratorPlan } from "@/lib/orchestrator/planner"

export async function executePlan(
  plan: OrchestratorPlan,
  opts: { projectId: string; idempotencyKey?: string; files?: GeneratedFile[] }
): Promise<{ success: boolean; files?: GeneratedFile[]; providerResult?: any; error?: string }> {
  const projectId = opts.projectId
  let contextFiles: GeneratedFile[] = opts.files || []
  let lastProviderResult: any = null

  for (const task of plan.tasks || []) {
    let taskSucceeded = false
    let lastError: any = null

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (task.type === "ai:generate") {
          const model = chooseModelForTask("generate")
          const ctx = buildContextForTask({ prompt: task.payload?.prompt || plan.prompt, files: contextFiles, maxFiles: 8 })

          const providerResp = await ProviderRouter.generate({
            provider: model.provider as ProviderName,
            modelName: model.modelName,
            prompt: ctx,
            mode: "files",
          })

          lastProviderResult = providerResp
          const parsed = extractGeneratedFilesFromProviderMessage(providerResp.message)

          if (!parsed.files || parsed.files.length === 0) {
            throw new Error("No files parsed from provider response")
          }

          contextFiles = parsed.files
          taskSucceeded = true
          break
        }

        if (task.type === "validate") {
          const validation = await Executor.validateFiles(contextFiles)
          if (!validation.valid) {
            // ask strong model to inspect and return patched files
            const model = chooseModelForTask("inspect")
            const inspectPrompt = `Inspect validation issues and return a JSON array of files (path/content). Validation: ${JSON.stringify(
              validation.result
            )}`

            const providerResp = await ProviderRouter.generate({
              provider: model.provider as ProviderName,
              modelName: model.modelName,
              prompt: inspectPrompt + "\n\n" + buildContextForTask({ prompt: plan.prompt, files: contextFiles, maxFiles: 8 }),
              mode: "inspect",
            })

            lastProviderResult = providerResp
            const parsed = extractGeneratedFilesFromProviderMessage(providerResp.message)
            if (!parsed.files || parsed.files.length === 0) {
              throw new Error("Inspect did not return files to repair validation")
            }

            contextFiles = parsed.files
          }

          taskSucceeded = true
          break
        }

        if (task.type === "file:apply") {
          await Executor.applyFiles(projectId, task.payload?.prompt || plan.prompt, contextFiles)
          taskSucceeded = true
          break
        }

        // preview or other tasks are no-ops for the orchestrator core
        if (task.type === "preview") {
          taskSucceeded = true
          break
        }

        // Unknown task type: consider it succeeded to avoid blocking
        taskSucceeded = true
        break
      } catch (err) {
        lastError = err
        // simple backoff
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        continue
      }
    }

    if (!taskSucceeded) {
      return { success: false, error: `Task ${task.id} failed: ${String(lastError?.message || lastError)}`, providerResult: lastProviderResult }
    }
  }

  return { success: true, files: contextFiles, providerResult: lastProviderResult }
}

export default { executePlan }
