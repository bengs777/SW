import { prisma } from '@/lib/db/client'
import type { ProviderName } from './provider-router'
import type { GeneratedFile } from '@/lib/types'
import { normalizeFileLanguage } from '@/lib/workspace-state'
import buildPlan from '@/lib/orchestrator/planner'
import { executePlan } from '@/lib/orchestrator/agent-loop'

type OrchestratorOpts = {
  projectId: string
  prompt: string
  provider: ProviderName
  modelName: string
  idempotencyKey?: string
  signal?: AbortSignal
}

type OrchestratorExisting = {
  alreadyExists: true
  historyId: string
  files: GeneratedFile[]
}

type OrchestratorNew = {
  alreadyExists: false
  files: GeneratedFile[]
  providerResult: {
    message: string
    providerUsed: string
    modelUsed: string
    usedFallback: boolean
    primaryError?: string | null
  }
}

function parseStoredFiles(raw: string): GeneratedFile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  return parsed
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return null
      const r = item as Record<string, unknown>
      const path = typeof r.path === 'string' ? r.path : ''
      const content = typeof r.content === 'string' ? r.content : ''
      if (!path || !content) return null
      return {
        path,
        content,
        language: normalizeFileLanguage(
          typeof r.language === 'string' ? r.language : undefined
        ),
      } as GeneratedFile
    })
    .filter((f: GeneratedFile | null) => f !== null)
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

    if (existing && existing.result) {
      const files = parseStoredFiles(existing.result)
      if (files.length > 0) {
        return {
          alreadyExists: true,
          historyId: existing.id,
          files,
        }
      }
    }
  }

  // Build a local plan (no external AI calls) and run it via the agent loop
  const plan = await buildPlan(prompt, { projectId })
  const result = await executePlan(plan, {
    projectId,
    idempotencyKey,
    provider: opts.provider,
    modelName: opts.modelName,
    applyFiles: false,
    signal: opts.signal,
  })

  if (!result.success) {
    return {
      alreadyExists: false,
      files: result.files || [],
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
    files: result.files || [],
    providerResult: {
      message: result.providerResult?.message || JSON.stringify({ files: result.files || [] }),
      providerUsed: result.providerResult?.providerUsed || '',
      modelUsed: result.providerResult?.modelUsed || '',
      usedFallback: result.providerResult?.usedFallback || false,
      primaryError: null,
    },
  }
}

export default orchestrateGeneration
