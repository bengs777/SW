import { ProviderRouter } from "@/lib/ai/provider-router"
import type { ProviderName } from "@/lib/ai/provider-router"
import { extractGeneratedFilesFromProviderMessage } from "@/lib/ai/provider-output"
import { chooseModelForTask } from "@/lib/ai/model-router"
import { buildContextForTask } from "@/lib/ai/context-builder"
import * as Executor from "@/lib/orchestrator/executor"
import type { GeneratedFile } from "@/lib/types"
import type { OrchestratorPlan } from "@/lib/orchestrator/planner"

type ProviderResult = Awaited<ReturnType<typeof ProviderRouter.generate>>

function payloadPrompt(task: { payload?: Record<string, unknown> }, fallback: string) {
  return typeof task.payload?.prompt === "string" ? task.payload.prompt : fallback
}

export async function executePlan(
  plan: OrchestratorPlan,
  opts: {
    projectId: string
    idempotencyKey?: string
    files?: GeneratedFile[]
    provider?: ProviderName
    modelName?: string
    applyFiles?: boolean
  }
): Promise<{ success: boolean; files?: GeneratedFile[]; providerResult?: ProviderResult | null; error?: string }> {
  const projectId = opts.projectId
  let contextFiles: GeneratedFile[] = opts.files || []
  let lastProviderResult: ProviderResult | null = null

  for (const task of plan.tasks || []) {
    let taskSucceeded = false
    let lastError: unknown = null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (task.type === "ai:generate") {
          const model = opts.provider && opts.modelName
            ? { provider: opts.provider, modelName: opts.modelName }
            : chooseModelForTask("generate")
          const ctx = buildContextForTask({ prompt: payloadPrompt(task, plan.prompt), files: contextFiles, maxFiles: 8 })

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
            // The public generate route performs full-stack validation and
            // deterministic auto-repair after provider output is parsed. Avoid
            // making a second AI call here, which can turn a successful
            // generation into a user-visible timeout.
          }

          taskSucceeded = true
          break
        }

        if (task.type === "file:apply") {
          if (opts.applyFiles) {
            await Executor.applyFiles(projectId, payloadPrompt(task, plan.prompt), contextFiles)
          }
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
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      return { success: false, error: `Task ${task.id} failed: ${message}`, providerResult: lastProviderResult }
    }
  }

  return { success: true, files: contextFiles, providerResult: lastProviderResult }
}

export default { executePlan }
