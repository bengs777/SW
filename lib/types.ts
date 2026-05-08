// Project types
export interface Project {
  id: string
  name: string
  description: string
  framework?: string | null
  createdAt: Date
  updatedAt: Date
  userId: string
  status: "draft" | "deployed"
  deploymentUrl?: string
  templateId?: string
  memoryJson?: string | null
  versions: ProjectVersion[]
}

export interface ProjectVersion {
  id: string
  version: number
  createdAt: Date
  files: GeneratedFile[]
  prompt: string
}

// File types
export interface GeneratedFile {
  path: string
  content: string
  language: "tsx" | "ts" | "css" | "json" | "html" | "prisma" | "md" | "env"
}

export type PreviewViewport = "mobile" | "tablet" | "desktop"

export type PreviewContextSource = "editor" | "sandbox" | "api" | "template" | "ai"

export interface PreviewContextError {
  message: string
  filename?: string | null
  lineno?: number | null
  colno?: number | null
  source?: string | null
  stack?: string | null
}

export interface PreviewFileSnapshot {
  path: string
  language: GeneratedFile["language"]
  size: number
  isActive?: boolean
  isPreviewVisible?: boolean
  contentPreview?: string | null
}

export interface PreviewContext {
  source: PreviewContextSource
  projectId: string
  projectName?: string | null
  templateId?: string | null
  activeTab: "preview" | "code" | "explorer"
  viewport: PreviewViewport
  currentVersion?: number | null
  activeFilePath?: string | null
  activeFileLanguage?: GeneratedFile["language"] | null
  activeFileExcerpt?: string | null
  previewError?: PreviewContextError | null
  files: PreviewFileSnapshot[]
  previewFiles: PreviewFileSnapshot[]
  generatedFileCount: number
  previewFileCount: number
  notes?: string[]
}

export type DiagnosticSeverity = "error" | "warning" | "info"

export interface DiagnosticEntry {
  source: string
  message: string
  filePath?: string | null
  line?: number | null
  column?: number | null
  severity: DiagnosticSeverity
  code?: string | null
}

export interface EditorSelectionContext {
  filePath: string
  text: string
  startLine?: number | null
  startColumn?: number | null
  endLine?: number | null
  endColumn?: number | null
}

export interface GitDiffSnapshot {
  baseRef?: string | null
  headRef?: string | null
  summary?: string | null
  patch?: string | null
  filesChanged: string[]
}

export interface TerminalOutputSnapshot {
  command?: string | null
  cwd?: string | null
  output: string
  exitCode?: number | null
  completedAt?: string | null
}

export interface ProjectMemoryData {
  framework?: string | null
  uiStyle?: string | null
  database?: string | null
  auth?: string | null
  folderRules?: string | null
  naming?: string | null
  notes?: string[]
}

export interface AIContextSnapshot {
  projectId: string
  projectName?: string | null
  activeFile?: GeneratedFile | null
  selectedText?: EditorSelectionContext | null
  importedFiles?: GeneratedFile[]
  nearbyFiles?: GeneratedFile[]
  packageJson?: GeneratedFile | null
  tsconfig?: GeneratedFile | null
  diagnostics?: DiagnosticEntry[]
  gitDiff?: GitDiffSnapshot | null
  terminalOutput?: TerminalOutputSnapshot | null
  projectMemory?: ProjectMemoryData | null
}

export interface RequestTelemetry {
  projectId: string
  taskType: string
  modelUsed: string
  provider?: string | null
  latencyMs: number
  tokens: number
  success: boolean
  errorMessage?: string | null
  context?: AIContextSnapshot | null
  createdAt?: string
}

export interface ModelScore {
  modelName: string
  taskType: string
  provider?: string | null
  successRate: number
  avgLatency: number
  avgRating: number
  sampleCount: number
}

export interface PromptAttachment {
  id: string
  name: string
  originalName?: string
  mimeType: string
  size: number
  kind: "image" | "text" | "binary"
  content: string
  assetId?: string
  storageBucket?: string
  storagePath?: string
  uploadedAt?: string
  uploadedByUserId?: string
}

export interface StoredProjectAsset {
  id: string
  projectId: string
  userId: string
  originalName: string
  mimeType: string
  size: number
  kind: PromptAttachment["kind"]
  storageBucket: string
  storagePath: string
  createdAt: string
}

// Chat types
export interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: Date
  generatedCode?: string
  files?: GeneratedFile[]
  isGenerating?: boolean
  error?: string
}

export interface ModelOption {
  key: string
  label: string
  provider: "openrouter"
  modelName: string
  price: number
  isActive: boolean
  rank?: number
  description?: string
  note?: string
}

export interface Conversation {
  id: string
  projectId: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
}

// AI types
export interface AIGenerationRequest {
  prompt: string
  projectId: string
  history: Message[]
  attachments?: PromptAttachment[]
  context?: {
    existingFiles?: GeneratedFile[]
    template?: string
    previewContext?: PreviewContext
    aiContext?: AIContextSnapshot
  }
}

export interface AIGenerationResponse {
  message: string
  files: GeneratedFile[]
  thinking?: string
  error?: string
  moduleStatus?: ModuleStatusReport
}

export type ModuleStatusState = "ready" | "partial" | "planned" | "error"

export interface ModuleStatusItem {
  name: string
  status: ModuleStatusState
  detail: string
}

export interface ModuleStatusReport {
  projectName?: string
  previewStatus: "success" | "fallback" | "error"
  currentPhase: string
  ready: ModuleStatusItem[]
  partial: ModuleStatusItem[]
  planned: ModuleStatusItem[]
  errors: ModuleStatusItem[]
  nextSteps: string[]
}

export interface AIPlannerOutput {
  components: string[]
  structure: string
  styling: string
  interactions: string[]
}

// User types
export interface User {
  id: string
  email: string
  name?: string
  avatarUrl?: string
  createdAt: Date
  plan: "free" | "pro" | "team"
}

// Template types
export interface Template {
  id: string
  name: string
  description: string
  category: string
  thumbnail?: string
  files: GeneratedFile[]
  prompt: string
  featured?: boolean
  tags?: string[]
  stack?: string[]
  difficulty?: "beginner" | "intermediate" | "advanced"
  estimatedMinutes?: number
  previewNotes?: string
}

// Deployment types
export interface Deployment {
  id: string
  projectId: string
  versionId: string
  url: string
  status: "building" | "ready" | "error"
  createdAt: Date
  logs?: string[]
}

// Settings types
export interface ProjectSettings {
  framework: "next" | "react" | "vue"
  styling: "tailwind" | "css"
  typescript: boolean
  uiLibrary: "shadcn" | "none"
}

// API response types
export interface APIResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}
