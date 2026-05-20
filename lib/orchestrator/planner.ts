import { enhancePromptForSwift } from "@/lib/ai/prompt-enhancer"
import { parseStructuredIntent } from "@/lib/ai/architecture-intent"
import { buildArchitecturePlan } from "@/lib/ai/architecture-planner"
import { buildArchitectureDependencyGraph, buildProjectMemoryGraph } from "@/lib/ai/project-memory-graph"
import type { GeneratedFile } from "@/lib/types"

export type OrchestratorTask = {
  id: string
  type: string
  payload?: Record<string, unknown>
  requiresConfirmation?: boolean
}

export type OrchestratorPlan = {
  id: string
  prompt: string
  tasks: OrchestratorTask[]
  meta?: Record<string, unknown>
}

export async function buildPlan(
  prompt: string,
  options?: { projectId?: string; files?: GeneratedFile[]; promptLanguage?: string }
): Promise<OrchestratorPlan> {
  void options
  // Use local heuristic-based prompt enhancer to build a lightweight plan
  // This intentionally does not call external AI providers.
  const enhanced = await enhancePromptForSwift({ prompt, modelName: "local" })
  const existingFiles = options?.files || []
  const structuredIntent = parseStructuredIntent({ prompt })
  const architecturePlan = buildArchitecturePlan({
    intent: structuredIntent,
    existingFiles,
  })
  const projectMemory = buildProjectMemoryGraph({
    files: existingFiles,
    intent: structuredIntent,
    architecturePlan,
  })
  const dependencyGraph = buildArchitectureDependencyGraph({
    intent: structuredIntent,
    architecturePlan,
    memory: projectMemory,
  })

  const planId = `plan:${String(Date.now())}`

  // Basic task breakdown: generate -> validate -> apply -> preview
  const tasks: OrchestratorTask[] = [
    {
      id: `${planId}:t1`,
      type: "ai:generate",
      payload: {
        prompt: enhanced.prompt,
        summary: enhanced.summary,
        workPlan: enhanced.plan,
        projectMemory: enhanced.projectMemory,
        structuredIntent,
        architecturePlan,
        dependencyGraph,
      },
    },
    {
      id: `${planId}:t2`,
      type: "validate",
    },
    {
      id: `${planId}:t3`,
      type: "file:apply",
      payload: {
        prompt,
      },
    },
    {
      id: `${planId}:t4`,
      type: "preview",
    },
  ]

  return {
    id: planId,
    prompt,
    tasks,
    meta: {
      enhancedSummary: enhanced.summary,
      planSource: "local-heuristic",
      originalPrompt: prompt,
      structuredIntent,
      architecturePlan,
      projectMemory,
      dependencyGraph,
    },
  }
}

export default buildPlan
