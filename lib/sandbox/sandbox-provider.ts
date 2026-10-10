import http from "node:http"
import { createHash } from "node:crypto"
import type { GeneratedFile } from "@/lib/types"
import { getRuntimeSandbox, resetRuntimeSandbox, startRuntimeSandbox } from "@/lib/sandbox/runtime"
import { ProjectFilesystemService } from "@/lib/services/project-filesystem.service"
import { db } from "@/lib/db/client"
import { generationJobs } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"

export interface SandboxInstance {
  projectId: string
  status: string
  targetPort: number
  targetUrl: string
  previewUrl: string
  error: string | null
}

export interface SandboxProvider {
  getActiveProjectId(): string | null
  startSandbox(projectId: string, files?: GeneratedFile[]): Promise<SandboxInstance>
  stopSandbox(projectId: string): Promise<void>
  stopActiveSandbox(): Promise<void>
  getPreviewTarget(projectId: string): Promise<{ targetUrl: string; port: number } | null>
  getInstance(projectId: string): Promise<SandboxInstance | null>
}

class LocalSandboxProvider implements SandboxProvider {
  private activeProjectId: string | null = null

  getActiveProjectId(): string | null {
    return this.activeProjectId
  }

  async startSandbox(projectId: string, files?: GeneratedFile[]): Promise<SandboxInstance> {
    // 1. Enforce single active sandbox: stop previous active if different
    if (this.activeProjectId && this.activeProjectId !== projectId) {
      await this.stopSandbox(this.activeProjectId).catch(() => null)
    }

    // 2. Resolve files: from parameter or directly from persisted project database
    let targetFiles = files
    if (!targetFiles || targetFiles.length === 0) {
      targetFiles = await ProjectFilesystemService.readFiles(projectId)
    }

    if (!targetFiles || targetFiles.length === 0) {
      throw new Error(`Cannot start sandbox: no project files found in database for project ${projectId}`)
    }

    // 3. Start local sandbox runtime
    const result = await startRuntimeSandbox(projectId, targetFiles)
    this.activeProjectId = projectId

    const rawUrl = result.previewUrl || "http://127.0.0.1:4300"
    let targetPort = 4300
    try {
      const parsed = new URL(rawUrl)
      targetPort = Number(parsed.port) || 4300
    } catch {}

    return {
      projectId,
      status: result.status,
      targetPort,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      previewUrl: `/preview/${encodeURIComponent(projectId)}`,
      error: result.error,
    }
  }

  async stopSandbox(projectId: string): Promise<void> {
    await resetRuntimeSandbox(projectId)
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null
    }
  }

  async stopActiveSandbox(): Promise<void> {
    if (this.activeProjectId) {
      await this.stopSandbox(this.activeProjectId)
    }
  }

  async getPreviewTarget(projectId: string): Promise<{ targetUrl: string; port: number } | null> {
    // 1. Check if a worker or background process has an active preview recorded in DB
    try {
      const [latestJob] = await db
        .select({ previewUrl: generationJobs.previewUrl })
        .from(generationJobs)
        .where(eq(generationJobs.projectId, projectId))
        .orderBy(desc(generationJobs.createdAt))
        .limit(1)

      if (latestJob?.previewUrl) {
        const parsed = new URL(latestJob.previewUrl)
        const port = Number(parsed.port) || 4300
        const isAlive = await this.probePort(port)
        if (isAlive) {
          return { targetUrl: `http://127.0.0.1:${port}`, port }
        }
      }
    } catch {}

    // 2. Check in-memory state in current process (probing port liveness)
    const current = getRuntimeSandbox(projectId)
    if (current.status === "running" && current.previewUrl) {
      try {
        const parsed = new URL(current.previewUrl)
        const port = Number(parsed.port) || 4300
        const isAlive = await this.probePort(port)
        if (isAlive) {
          return { targetUrl: `http://127.0.0.1:${port}`, port }
        }
      } catch {}
    }

    // 3. Fallback: calculate deterministic port for project and probe if alive
    const numericHash = createHash("sha1").update(projectId).digest().readUInt32BE(0)
    const expectedPort = 4300 + (numericHash % 1000)
    const isExpectedAlive = await this.probePort(expectedPort)
    if (isExpectedAlive) {
      return { targetUrl: `http://127.0.0.1:${expectedPort}`, port: expectedPort }
    }

    // 4. If neither is running, start it on-demand from DB files (single active mode)
    try {
      const instance = await this.startSandbox(projectId)
      return { targetUrl: instance.targetUrl, port: instance.targetPort }
    } catch {
      return null
    }
  }

  private async probePort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const client = http.get(`http://127.0.0.1:${port}/`, { timeout: 1000 }, (res) => {
        resolve(true)
        res.resume()
      })
      client.on("error", () => resolve(false))
      client.on("timeout", () => {
        client.destroy()
        resolve(false)
      })
    })
  }

  async getInstance(projectId: string): Promise<SandboxInstance | null> {
    const current = getRuntimeSandbox(projectId)
    let targetPort = 4300
    if (current.previewUrl) {
      try {
        const parsed = new URL(current.previewUrl)
        targetPort = Number(parsed.port) || 4300
      } catch {}
    }

    return {
      projectId,
      status: current.status,
      targetPort,
      targetUrl: `http://127.0.0.1:${targetPort}`,
      previewUrl: `/preview/${encodeURIComponent(projectId)}`,
      error: current.error,
    }
  }
}

// Global singleton to survive module reloads
const globalForProvider = globalThis as unknown as {
  swiftSandboxProvider?: SandboxProvider
}

export const sandboxProvider = globalForProvider.swiftSandboxProvider ?? new LocalSandboxProvider()
globalForProvider.swiftSandboxProvider = sandboxProvider
