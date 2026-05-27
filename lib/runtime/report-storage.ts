import { randomUUID } from "node:crypto"
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type ReportRetentionPolicy = {
  retentionDays: number
  cleanupTempAfterMinutes: number
  maxCleanupEntries: number
}

export type ReportCleanupResult = {
  root: string
  policy: ReportRetentionPolicy
  scanned: number
  removed: number
  skipped: number
  errors: Array<{ path: string; message: string }>
}

const DEFAULT_LOCAL_RETENTION_DAYS = 30
const DEFAULT_SERVERLESS_RETENTION_DAYS = 7
const DEFAULT_TEMP_CLEANUP_MINUTES = 60
const DEFAULT_MAX_CLEANUP_ENTRIES = 500
const REPORT_TEMP_PREFIX = ".tmp-"

export function getReportStoragePath(): string {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "swift-reports")
  }

  return path.join(process.cwd(), ".swift-reports")
}

export function getReportRetentionPolicy(): ReportRetentionPolicy {
  return {
    retentionDays: clampPositiveInteger(
      process.env.SWIFT_REPORT_RETENTION_DAYS,
      process.env.VERCEL ? DEFAULT_SERVERLESS_RETENTION_DAYS : DEFAULT_LOCAL_RETENTION_DAYS
    ),
    cleanupTempAfterMinutes: clampPositiveInteger(
      process.env.SWIFT_REPORT_TEMP_RETENTION_MINUTES,
      DEFAULT_TEMP_CLEANUP_MINUTES
    ),
    maxCleanupEntries: clampPositiveInteger(
      process.env.SWIFT_REPORT_CLEANUP_MAX_ENTRIES,
      DEFAULT_MAX_CLEANUP_ENTRIES
    ),
  }
}

export function safeReportSegment(value: string) {
  return String(value || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || "unknown"
}

export function buildReportRunId(seed?: string | null) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const pid = process.pid || 0
  const suffix = randomUUID().slice(0, 12)
  const safeSeed = seed ? `${safeReportSegment(seed)}-` : ""
  return `${safeSeed}${stamp}-${pid}-${suffix}`
}

export async function createReportDirectory(category: string, seed?: string | null) {
  const dir = path.join(getReportStoragePath(), safeReportSegment(category), buildReportRunId(seed))
  await mkdir(dir, { recursive: true })
  void cleanupReportStorage().catch(() => null)
  return dir
}

export async function ensureReportDirectory(...segments: string[]) {
  const dir = path.join(getReportStoragePath(), ...segments.map(safeReportSegment))
  await mkdir(dir, { recursive: true })
  void cleanupReportStorage().catch(() => null)
  return dir
}

export async function atomicWriteFile(filePath: string, data: string | Buffer) {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })

  const tempPath = path.join(
    dir,
    `${REPORT_TEMP_PREFIX}${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )

  await writeFile(tempPath, data)
  await rename(tempPath, filePath)
}

export async function writeJsonReport(filePath: string, value: unknown) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextReport(filePath: string, value: string) {
  await atomicWriteFile(filePath, value.endsWith("\n") ? value : `${value}\n`)
}

export async function cleanupReportStorage(input?: {
  root?: string
  policy?: Partial<ReportRetentionPolicy>
  dryRun?: boolean
}): Promise<ReportCleanupResult> {
  const root = input?.root || getReportStoragePath()
  const basePolicy = getReportRetentionPolicy()
  const policy = {
    ...basePolicy,
    ...input?.policy,
  }
  const now = Date.now()
  const reportCutoff = now - policy.retentionDays * 24 * 60 * 60 * 1000
  const tempCutoff = now - policy.cleanupTempAfterMinutes * 60 * 1000
  const result: ReportCleanupResult = {
    root,
    policy,
    scanned: 0,
    removed: 0,
    skipped: 0,
    errors: [],
  }

  let rootStat
  try {
    rootStat = await stat(root)
  } catch {
    return result
  }

  if (!rootStat.isDirectory()) {
    result.skipped += 1
    return result
  }

  const entries = await listReportEntries(root, policy.maxCleanupEntries)
  for (const entry of entries) {
    result.scanned += 1
    const baseName = path.basename(entry.path)
    const cutoff = baseName.startsWith(REPORT_TEMP_PREFIX) ? tempCutoff : reportCutoff

    if (entry.mtimeMs >= cutoff) {
      result.skipped += 1
      continue
    }

    try {
      if (!input?.dryRun) {
        await rm(entry.path, { recursive: entry.isDirectory, force: true })
      }
      result.removed += 1
    } catch (error) {
      result.errors.push({
        path: entry.path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

async function listReportEntries(root: string, maxEntries: number) {
  const queue = [root]
  const entries: Array<{ path: string; isDirectory: boolean; mtimeMs: number }> = []
  const rootResolved = path.resolve(root)

  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift()!
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of children) {
      if (entries.length >= maxEntries) break
      const childPath = path.join(current, child.name)
      const resolved = path.resolve(childPath)
      if (resolved === rootResolved || !resolved.startsWith(`${rootResolved}${path.sep}`)) {
        continue
      }

      let childStat
      try {
        childStat = await stat(childPath)
      } catch {
        continue
      }

      const isDirectory = child.isDirectory()
      entries.push({
        path: childPath,
        isDirectory,
        mtimeMs: childStat.mtimeMs,
      })

      if (isDirectory) {
        queue.push(childPath)
      }
    }
  }

  return entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
}

function clampPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}
