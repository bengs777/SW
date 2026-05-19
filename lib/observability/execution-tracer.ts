import { randomUUID } from "node:crypto"
import { log } from "@/lib/logging"
import { classifyRuntimeError } from "@/lib/observability/performance-monitor"

export type ExecutionTimelineEvent =
  | "request_received"
  | "planner_started"
  | "generation_started"
  | "validation_started"
  | "repair_retry"
  | "build_started"
  | "build_finished"
  | "task_completed"
  | "task_failed"
  | "queue_enqueued"
  | "worker_started"
  | "provider_started"
  | "provider_finished"

export type ExecutionTraceContext = {
  taskId: string
  sessionId?: string | null
  workerId?: string | null
  agentType?: string
  correlationId: string
  traceId: string
  executionChainId: string
}

export type ExecutionTraceRecord = ExecutionTraceContext & {
  event: ExecutionTimelineEvent | string
  at: string
  durationMs?: number
  meta?: Record<string, unknown>
}

const MAX_TRACE_RECORDS = 500
const traces: ExecutionTraceRecord[] = []

export function createCorrelationIds(input?: {
  correlationId?: string | null
  traceId?: string | null
  executionChainId?: string | null
}) {
  const correlationId = input?.correlationId || randomUUID()
  return {
    correlationId,
    traceId: input?.traceId || correlationId,
    executionChainId: input?.executionChainId || randomUUID(),
  }
}

export function traceExecution(
  context: ExecutionTraceContext,
  event: ExecutionTimelineEvent | string,
  meta: Record<string, unknown> = {}
) {
  const record: ExecutionTraceRecord = {
    ...context,
    event,
    at: new Date().toISOString(),
    meta,
  }
  traces.push(record)
  if (traces.length > MAX_TRACE_RECORDS) {
    traces.splice(0, traces.length - MAX_TRACE_RECORDS)
  }
  log(event === "task_failed" ? "error" : "info", "execution_trace", record)
  return record
}

export function traceError(context: ExecutionTraceContext, error: unknown, meta: Record<string, unknown> = {}) {
  return traceExecution(context, "task_failed", {
    ...meta,
    errorCode: classifyRuntimeError(error),
    error: error instanceof Error ? error.message : String(error),
  })
}

export function getExecutionTraceSnapshot(filter?: { taskId?: string; traceId?: string; correlationId?: string }) {
  return traces
    .filter((trace) => {
      if (filter?.taskId && trace.taskId !== filter.taskId) return false
      if (filter?.traceId && trace.traceId !== filter.traceId) return false
      if (filter?.correlationId && trace.correlationId !== filter.correlationId) return false
      return true
    })
    .slice(-100)
}
