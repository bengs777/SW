import { prisma } from '@/lib/db/client'
import type { ProviderName } from './provider-router'
import type { GeneratedFile } from '@/lib/types'
import buildPlan from '@/lib/orchestrator/planner'
import { executePlan } from '@/lib/orchestrator/agent-loop'

type OrchestratorOpts = {
  projectId: string
  prompt: string
  provider: ProviderName
  modelName: string
  idempotencyKey?: string
}

type OrchestratorExisting = {
  alreadyExists: true
  historyId: string
  files: GeneratedFile[]
}

type OrchestratorNew = {
  alreadyExists: false
  providerResult: {
    message: string
    providerUsed: string
    modelUsed: string
    usedFallback: boolean
    primaryError?: string | null
  }
}

export async function orchestrateGeneration(opts: OrchestratorOpts): Promise<OrchestratorExisting | OrchestratorNew> {
  const { projectId, idempotencyKey, prompt } = opts

  if (idempotencyKey) {
    const existing = await prisma.generationHistory.findFirst({
      where: {
        projectId,
        idempotencyKey,
      },
    })

    if (existing) {
      try {
        const files = JSON.parse(existing.result) as GeneratedFile[]
        return {
          alreadyExists: true,
          historyId: existing.id,
          files,
        }
      } catch {
        // continue to regenerate if parsing fails
      }
    }
  }

  // Build a local plan (no external AI calls) and run it via the agent loop
  const plan = await buildPlan(prompt, { projectId })
  const result = await executePlan(plan, { projectId, idempotencyKey })

  if (!result.success) {
    return {
      alreadyExists: false,
      providerResult: {
        message: result.error || 'Orchestrator failed',
        providerUsed: result.providerResult?.providerUsed || '',
        modelUsed: result.providerResult?.modelUsed || '',
        usedFallback: result.providerResult?.usedFallback || false,
        primaryError: result.error || result.providerResult?.primaryError || null,
      },
    }
  }

  return {
    alreadyExists: false,
    providerResult: {
      message: 'Orchestrator completed',
      providerUsed: result.providerResult?.providerUsed || '',
      modelUsed: result.providerResult?.modelUsed || '',
      usedFallback: result.providerResult?.usedFallback || false,
      primaryError: null,
    },
  }
}

export default orchestrateGeneration
