import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { env } from "@/lib/env"

let storageAdminClient: SupabaseClient | null = null

const STORAGE_SAFE_SEGMENT_PATTERN = /[^a-zA-Z0-9._-]+/g
const IMAGE_MIME_PREFIX = "image/"

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "sql",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "prisma",
  "svg",
  "sh",
  "bat",
  "cmd",
])

function assertStorageConfig() {
  const missing: string[] = []

  if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL")
  if (!env.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY")
  if (!env.supabaseStorageBucket) missing.push("SUPABASE_STORAGE_BUCKET")

  if (missing.length > 0) {
    throw new Error(`Missing required Supabase storage variables: ${missing.join(", ")}`)
  }
}

function normalizeStorageSegment(value: string) {
  return value
    .trim()
    .replace(STORAGE_SAFE_SEGMENT_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file"
}

function getFileExtension(fileName: string) {
  const parts = fileName.toLowerCase().split(".")
  return parts.length > 1 ? parts.pop() || "" : ""
}

export function detectAttachmentKind(mimeType: string, fileName: string) {
  if (mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return "image" as const
  }

  if (mimeType.startsWith("text/")) {
    return "text" as const
  }

  if (TEXT_EXTENSIONS.has(getFileExtension(fileName))) {
    return "text" as const
  }

  return "binary" as const
}

export function buildProjectAssetStoragePath(projectId: string, userId: string, fileName: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const safeProjectId = normalizeStorageSegment(projectId)
  const safeUserId = normalizeStorageSegment(userId)
  const safeFileName = normalizeStorageSegment(fileName)

  return `projects/${safeProjectId}/users/${safeUserId}/${stamp}-${safeFileName}`
}

export function createSupabaseStorageAdminClient() {
  assertStorageConfig()

  if (!storageAdminClient) {
    storageAdminClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }

  return storageAdminClient
}

export async function uploadProjectAssetToStorage(input: {
  bucket: string
  storagePath: string
  file: File
}) {
  const client = createSupabaseStorageAdminClient()
  const buffer = Buffer.from(await input.file.arrayBuffer())
  const contentType = input.file.type || "application/octet-stream"

  const { error } = await client.storage.from(input.bucket).upload(input.storagePath, buffer, {
    contentType,
    cacheControl: "3600",
    upsert: false,
  })

  if (error) {
    throw new Error(`Supabase upload failed for ${input.file.name || input.storagePath}: ${error.message}`)
  }
}

export async function deleteProjectAssetFromStorage(input: {
  bucket: string
  storagePath: string
}) {
  const client = createSupabaseStorageAdminClient()
  const { error } = await client.storage.from(input.bucket).remove([input.storagePath])

  if (error) {
    throw new Error(`Supabase cleanup failed for ${input.storagePath}: ${error.message}`)
  }
}