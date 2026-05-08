import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Project, Message, GeneratedFile, User, Template } from "./types"

// Project Store
interface ProjectState {
  projects: Project[]
  currentProject: Project | null
  isLoading: boolean
  error: string | null
  
  // Actions
  setProjects: (projects: Project[]) => void
  setCurrentProject: (project: Project | null) => void
  addProject: (project: Project) => void
  updateProject: (id: string, updates: Partial<Project>) => void
  deleteProject: (id: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projects: [],
      currentProject: null,
      isLoading: false,
      error: null,

      setProjects: (projects) => set({ projects }),
      setCurrentProject: (project) => set({ currentProject: project }),
      addProject: (project) =>
        set((state) => ({ projects: [...state.projects, project] })),
      updateProject: (id, updates) =>
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
          currentProject:
            state.currentProject?.id === id
              ? { ...state.currentProject, ...updates }
              : state.currentProject,
        })),
      deleteProject: (id) =>
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          currentProject:
            state.currentProject?.id === id ? null : state.currentProject,
        })),
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),
    }),
    {
      name: "swift-projects",
      partialize: (state) => ({ projects: state.projects }),
    }
  )
)

// Chat Store
interface ChatState {
  messages: Message[]
  isGenerating: boolean
  
  // Actions
  addMessage: (message: Message) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
  clearMessages: () => void
  setGenerating: (generating: boolean) => void
}

export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  isGenerating: false,

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),
  clearMessages: () => set({ messages: [] }),
  setGenerating: (generating) => set({ isGenerating: generating }),
}))

// Editor Store
interface EditorState {
  files: GeneratedFile[]
  activeFileIndex: number
  currentVersion: number
  isDirty: boolean
  previewMode: "preview" | "code"
  viewport: "mobile" | "tablet" | "desktop"
  
  // Actions
  setFiles: (files: GeneratedFile[]) => void
  addFile: (file: GeneratedFile) => void
  updateFile: (index: number, content: string) => void
  setActiveFile: (index: number) => void
  setVersion: (version: number) => void
  setDirty: (dirty: boolean) => void
  setPreviewMode: (mode: "preview" | "code") => void
  setViewport: (viewport: "mobile" | "tablet" | "desktop") => void
  reset: () => void
}

export const useEditorStore = create<EditorState>()((set) => ({
  files: [],
  activeFileIndex: 0,
  currentVersion: 0,
  isDirty: false,
  previewMode: "preview",
  viewport: "desktop",

  setFiles: (files) => set({ files, currentVersion: 1, isDirty: false }),
  addFile: (file) =>
    set((state) => ({ files: [...state.files, file], isDirty: true })),
  updateFile: (index, content) =>
    set((state) => ({
      files: state.files.map((f, i) =>
        i === index ? { ...f, content } : f
      ),
      isDirty: true,
    })),
  setActiveFile: (index) => set({ activeFileIndex: index }),
  setVersion: (version) => set({ currentVersion: version }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setPreviewMode: (mode) => set({ previewMode: mode }),
  setViewport: (viewport) => set({ viewport }),
  reset: () =>
    set({
      files: [],
      activeFileIndex: 0,
      currentVersion: 0,
      isDirty: false,
      previewMode: "preview",
      viewport: "desktop",
    }),
}))

// User Store
interface UserState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  
  // Actions
  setUser: (user: User | null) => void
  setAuthenticated: (authenticated: boolean) => void
  setLoading: (loading: boolean) => void
  logout: () => void
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,

      setUser: (user) => set({ user, isAuthenticated: !!user }),
      setAuthenticated: (authenticated) => set({ isAuthenticated: authenticated }),
      setLoading: (loading) => set({ isLoading: loading }),
      logout: () => set({ user: null, isAuthenticated: false }),
    }),
    {
      name: "swift-user",
      partialize: (state) => ({ user: state.user }),
    }
  )
)

// Template Store
interface TemplateState {
  templates: Template[]
  selectedTemplate: Template | null
  isLoading: boolean
  
  // Actions
  setTemplates: (templates: Template[]) => void
  selectTemplate: (template: Template | null) => void
  setLoading: (loading: boolean) => void
}

export const useTemplateStore = create<TemplateState>()((set) => ({
  templates: [],
  selectedTemplate: null,
  isLoading: false,

  setTemplates: (templates) => set({ templates }),
  selectTemplate: (template) => set({ selectedTemplate: template }),
  setLoading: (loading) => set({ isLoading: loading }),
}))
