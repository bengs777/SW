export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const SENSITIVE_KEY_RE = /token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key|session/i
const MAX_STRING_LENGTH = 1200
const MAX_DEPTH = 5

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MaxDepth]"
  if (value === null || typeof value === "undefined") return value
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactLogValue(item, depth + 1))
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactLogValue(entry, depth + 1),
      ])
    )
  }

  return String(value)
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event: message,
    msg: message,
    ...((meta && Object.keys(meta).length > 0) ? { meta: redactLogValue(meta) } : {}),
  }

  if (level === 'error') {
    console.error(JSON.stringify(payload))
    return
  }

  if (level === 'warn') {
    console.warn(JSON.stringify(payload))
    return
  }

  console.log(JSON.stringify(payload))
}

export default log
