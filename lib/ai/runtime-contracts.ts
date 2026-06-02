import { z } from "zod"
import type { GeneratedArtifact } from "@/lib/ai/generated-artifact"

export type ValidatorDiagnostic = {
  error: string
  reason: string
  received?: string
  expected?: string
  allowedRootFiles?: readonly string[]
  metadata?: Record<string, unknown>
}

export type RuntimeTelemetry = {
  event: string
  stage?: string
  status?: string
  durationMs?: number
  metadata?: Record<string, unknown>
}

export type RepairMetadata = {
  attempt: number
  reason: string
  targetFiles?: string[]
  changedFiles?: string[]
  metadata?: Record<string, unknown>
}

export type GeneratedArtifactEnvelope = {
  artifacts: GeneratedArtifact[]
}

export type RuntimeMessage =
  | { kind: "artifact"; data: GeneratedArtifactEnvelope }
  | { kind: "diagnostic"; data: ValidatorDiagnostic }
  | { kind: "telemetry"; data: RuntimeTelemetry }
  | { kind: "repair"; data: RepairMetadata }

const validatorDiagnosticSchema = z.object({
  error: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  received: z.string().optional(),
  expected: z.string().optional(),
  allowedRootFiles: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough()

const runtimeTelemetrySchema = z.object({
  event: z.string().trim().min(1),
  stage: z.string().optional(),
  status: z.string().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough()

const repairMetadataSchema = z.object({
  attempt: z.number().int().nonnegative(),
  reason: z.string().trim().min(1),
  targetFiles: z.array(z.string()).optional(),
  changedFiles: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough()

export function parseValidatorDiagnostic(value: unknown): ValidatorDiagnostic | null {
  const parsed = validatorDiagnosticSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isValidatorDiagnosticPayload(value: unknown): value is ValidatorDiagnostic {
  return parseValidatorDiagnostic(value) !== null
}

export function parseRuntimeMessage(value: unknown): RuntimeMessage | null {
  const base = z.object({
    kind: z.enum(["artifact", "diagnostic", "telemetry", "repair"]),
    data: z.unknown(),
  }).safeParse(value)

  if (!base.success) {
    const diagnostic = parseValidatorDiagnostic(value)
    return diagnostic ? { kind: "diagnostic", data: diagnostic } : null
  }

  if (base.data.kind === "diagnostic") {
    const diagnostic = parseValidatorDiagnostic(base.data.data)
    return diagnostic ? { kind: "diagnostic", data: diagnostic } : null
  }

  if (base.data.kind === "telemetry") {
    const telemetry = runtimeTelemetrySchema.safeParse(base.data.data)
    return telemetry.success ? { kind: "telemetry", data: telemetry.data } : null
  }

  if (base.data.kind === "repair") {
    const repair = repairMetadataSchema.safeParse(base.data.data)
    return repair.success ? { kind: "repair", data: repair.data } : null
  }

  if (
    base.data.data &&
    typeof base.data.data === "object" &&
    Array.isArray((base.data.data as { artifacts?: unknown }).artifacts)
  ) {
    return { kind: "artifact", data: base.data.data as GeneratedArtifactEnvelope }
  }

  return null
}

export function publicGenerationStructureErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")
  if (
    /MALFORMED_GENERATED_ARTIFACT|Unrecognized key\(s\)|strict-json-schema|required|PATH_ERROR|diagnostic payload/i.test(message)
  ) {
    return "AI generated invalid project structure. Repair loop attempting automatic correction..."
  }
  return message || "AI generated invalid project structure. Repair loop attempting automatic correction..."
}

export function publicGenerationRuntimeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "")

  if (/Sandbox storage exhausted|no space left on device|ENOSPC/i.test(message)) {
    return "Sandbox storage penuh. Sistem belum bisa install dependency untuk preview. Tunggu sampai storage sandbox dibersihkan atau volume diperbesar, lalu jalankan ulang prompt."
  }

  if (
    /Production generation must run in queue mode with a dedicated worker|GENERATION_WORKER_HEARTBEAT|worker.*missing|worker.*heartbeat|dedicated worker|SWIFT_WORKER_HEALTH_URL/i.test(message)
  ) {
    return "Swift production sedang menunggu dedicated worker. Pastikan worker generation aktif, lalu jalankan ulang prompt."
  }

  if (/Generation queue unavailable|Redis\/BullMQ|queue.*unavailable|queue_enqueue|BullMQ|dead-letter|dead letter/i.test(message)) {
    return "Swift queue belum siap menerima job. Sistem akan aman jika Redis dan worker sudah sehat, lalu prompt bisa dijalankan ulang."
  }

  if (/SYSTEM_SATURATED|temporarily saturated/i.test(message)) {
    return "Swift sedang penuh sementara. Tunggu sebentar lalu coba ulang prompt."
  }

  if (
    /MALFORMED_GENERATED_ARTIFACT|Unrecognized key\(s\)|strict-json-schema|required|PATH_ERROR|diagnostic payload/i.test(message)
  ) {
    return publicGenerationStructureErrorMessage(error)
  }

  return message || "Generate gagal. Buka Logs untuk detail error."
}
