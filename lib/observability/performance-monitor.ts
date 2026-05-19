import { log, type LogLevel } from "@/lib/logging"

export type RuntimeErrorCode =
  | "PATH_ERROR"
  | "SCHEMA_ERROR"
  | "BUILD_ERROR"
  | "TYPE_ERROR"
  | "AI_TIMEOUT"
  | "RATE_LIMIT"
  | "DB_CONNECTION_ERROR"
  | "REDIS_ERROR"
  | "SANDBOX_ERROR"
  | "UNKNOWN"

export type SlowOperationType =
  | "generation"
  | "build"
  | "prisma"
  | "redis"
  | "openrouter"
  | "validation"
  | "repair"

const SLOW_THRESHOLDS_MS: Record<SlowOperationType, number> = {
  generation: 30_000,
  build: 60_000,
  prisma: 2_000,
  redis: 500,
  openrouter: 10_000,
  validation: 30_000,
  repair: 30_000,
}

export function classifyRuntimeError(error: unknown): RuntimeErrorCode {
  const message = error instanceof Error ? error.message : String(error || "")
  if (/path|traversal|outside allowed|absolute|node_modules|\.env|\.git/i.test(message)) return "PATH_ERROR"
  if (/schema|zod|malformed_generated_artifact|json|validation/i.test(message)) return "SCHEMA_ERROR"
  if (/build|next build|production build/i.test(message)) return "BUILD_ERROR"
  if (/typecheck|typescript|tsc|type error/i.test(message)) return "TYPE_ERROR"
  if (/timeout|timed out|aborted/i.test(message)) return "AI_TIMEOUT"
  if (/rate limit|429|too many/i.test(message)) return "RATE_LIMIT"
  if (/prisma|postgres|database|connection.*closed|ECONNRESET|ETIMEDOUT/i.test(message)) return "DB_CONNECTION_ERROR"
  if (/redis|bullmq|queue/i.test(message)) return "REDIS_ERROR"
  if (/sandbox|runtime smoke|preview/i.test(message)) return "SANDBOX_ERROR"
  return "UNKNOWN"
}

export function warnIfSlow(
  operation: SlowOperationType,
  durationMs: number,
  meta: Record<string, unknown> = {}
) {
  const thresholdMs = SLOW_THRESHOLDS_MS[operation]
  if (durationMs <= thresholdMs) return

  log("warn", "slow_operation", {
    operation,
    durationMs: Math.round(durationMs),
    thresholdMs,
    ...meta,
  })
}

export async function monitorOperation<T>(
  operation: SlowOperationType,
  event: string,
  fn: () => Promise<T>,
  meta: Record<string, unknown> = {},
  level: LogLevel = "info"
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    const durationMs = Date.now() - startedAt
    warnIfSlow(operation, durationMs, meta)
    log(level, event, {
      ...meta,
      operation,
      status: "success",
      durationMs,
    })
    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt
    log("error", event, {
      ...meta,
      operation,
      status: "failed",
      durationMs,
      errorCode: classifyRuntimeError(error),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function getMemoryUsageSnapshot() {
  const memory = process.memoryUsage()
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  }
}
