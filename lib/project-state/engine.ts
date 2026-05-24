import { prisma } from "@/lib/db/client"
import type { GeneratedFile } from "@/lib/types"
import { ProjectFilesystemService, type ProjectFileManifest } from "@/lib/services/project-filesystem.service"
import { buildProjectDependencyGraph, type ProjectDependencyGraph } from "@/lib/project-state/dependency-graph"
import { rankProjectContext, type RankedProjectContext } from "@/lib/project-state/context-ranking"
import { log } from "@/lib/logging"

export type ProjectBuildStatus = {
  status: "unknown" | "passed" | "failed"
  checkedAt: string | null
  failingFiles: string[]
  summary?: string | null
}

export type ProjectGeneratedArtifactRef = {
  id: string
  version: number
  prompt: string
  createdAt: string
  fileCount: number
}

export type SwiftProjectState = {
  projectId: string
  files: GeneratedFile[]
  dependencyGraph: ProjectDependencyGraph
  conversationHistory: Array<{ prompt: string; createdAt: string; intent?: string | null }>
  buildStatus: ProjectBuildStatus
  generatedArtifacts: ProjectGeneratedArtifactRef[]
  metadata: {
    loadedAt: string
    manifest: ProjectFileManifest
    version: number
    hasProjectState: true
    context: RankedProjectContext
  }
}

export async function loadProjectState(input: {
  projectId: string
  prompt: string
  modifiedPaths?: string[]
  failingPaths?: string[]
}): Promise<SwiftProjectState> {
  const [files, histories, project] = await Promise.all([
    ProjectFilesystemService.readFiles(input.projectId),
    prisma.generationHistory.findMany({
      where: { projectId: input.projectId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, prompt: true, intent: true, result: true, createdAt: true },
    }),
    prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, memoryJson: true, updatedAt: true },
    }),
  ])

  if (!project) {
    throw new Error(`Project state load failed: project ${input.projectId} not found.`)
  }

  const dependencyGraph = buildProjectDependencyGraph(files)
  const buildStatus = readBuildStatus(project.memoryJson)
  const context = rankProjectContext({
    files,
    dependencyGraph,
    modifiedPaths: input.modifiedPaths,
    failingPaths: [...(input.failingPaths || []), ...buildStatus.failingFiles],
  })

  const state: SwiftProjectState = {
    projectId: input.projectId,
    files,
    dependencyGraph,
    conversationHistory: histories.slice(0, 10).map((entry) => ({
      prompt: entry.prompt,
      intent: entry.intent,
      createdAt: entry.createdAt.toISOString(),
    })),
    buildStatus,
    generatedArtifacts: histories.map((entry, index) => ({
      id: entry.id,
      version: histories.length - index,
      prompt: entry.prompt,
      createdAt: entry.createdAt.toISOString(),
      fileCount: countSnapshotFiles(entry.result),
    })),
    metadata: {
      loadedAt: new Date().toISOString(),
      manifest: ProjectFilesystemService.buildManifest(files),
      version: histories.length,
      hasProjectState: true,
      context,
    },
  }

  log("info", "project_state_loaded", {
    event: "project_state_loaded",
    projectId: input.projectId,
    fileCount: state.files.length,
    version: state.metadata.version,
    contextFiles: context.selectedPaths,
    omittedContextFileCount: context.omittedPaths.length,
  })

  return state
}

export function buildProjectStatePromptBlock(state: SwiftProjectState) {
  return [
    "PROJECT_STATE_ENGINE:",
    `- projectId: ${state.projectId}`,
    `- version: v${state.metadata.version}`,
    `- files: ${state.files.length}`,
    `- build_status: ${state.buildStatus.status}`,
    `- context_budget: maxFiles=10 maxTotalChars=64KB selected=${state.metadata.context.selectedPaths.length} chars=${state.metadata.context.totalChars}`,
    "- RULE: Generate or modify ONLY from this loaded project state. Do not invent a separate project.",
    "- RULE: Use diff/patch operations. Do not rewrite the full project.",
    "- RULE: maxChangedFilesPerRequest=5.",
    "- Allowed operations: createFile, modifyFile, deleteFile, patchFile.",
    "PROJECT_CONTEXT_FILES:",
    JSON.stringify(
      state.metadata.context.files.map((file) => ({
        path: file.path,
        language: file.language,
        content: file.content,
      })),
      null,
      2
    ),
    "DEPENDENCY_GRAPH:",
    JSON.stringify(state.dependencyGraph, null, 2),
    "CONVERSATION_HISTORY:",
    JSON.stringify(state.conversationHistory, null, 2),
  ].join("\n")
}

export async function persistProjectStateMetadata(input: {
  projectId: string
  files: GeneratedFile[]
  buildStatus: ProjectBuildStatus
  metadata?: Record<string, unknown>
}) {
  const dependencyGraph = buildProjectDependencyGraph(input.files)
  const manifest = ProjectFilesystemService.buildManifest(input.files)
  const memoryJson = JSON.stringify({
    ...(input.metadata || {}),
    projectState: {
      files: manifest.paths,
      dependencyGraph,
      buildStatus: input.buildStatus,
      generatedArtifacts: {
        lastSnapshotAt: new Date().toISOString(),
      },
      metadata: {
        manifest,
        updatedAt: new Date().toISOString(),
      },
    },
  })

  await prisma.project.update({
    where: { id: input.projectId },
    data: { memoryJson },
  })
}

function readBuildStatus(memoryJson: string | null | undefined): ProjectBuildStatus {
  try {
    const parsed = JSON.parse(String(memoryJson || "{}"))
    const status = parsed?.projectState?.buildStatus || parsed?.buildStatus || null
    const rawStatus = String(status?.status || "unknown")
    return {
      status: rawStatus === "passed" || rawStatus === "failed" ? rawStatus : "unknown",
      checkedAt: typeof status?.checkedAt === "string" ? status.checkedAt : null,
      failingFiles: Array.isArray(status?.failingFiles)
        ? status.failingFiles.filter((item: unknown): item is string => typeof item === "string")
        : [],
      summary: typeof status?.summary === "string" ? status.summary : null,
    }
  } catch {
    return { status: "unknown", checkedAt: null, failingFiles: [] }
  }
}

function countSnapshotFiles(result: string) {
  try {
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}
