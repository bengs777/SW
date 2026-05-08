import { prisma } from '@/lib/db/client'
import { ProviderRouter } from './provider-router'
import type { ProviderName } from './provider-router'
import type { GeneratedFile } from '@/lib/types'

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
  const { projectId, idempotencyKey } = opts

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

  // Delegate to ProviderRouter which handles primary+fallback providers
  const providerResult = await ProviderRouter.generate({
    provider: opts.provider,
    modelName: opts.modelName,
    prompt: opts.prompt,
  })

  return {
    alreadyExists: false,
    providerResult: {
      message: providerResult.message,
      providerUsed: providerResult.providerUsed,
      modelUsed: providerResult.modelUsed,
      usedFallback: providerResult.usedFallback,
      primaryError: providerResult.primaryError ?? null,
    },
  }
}

export default orchestrateGeneration
