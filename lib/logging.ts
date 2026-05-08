export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...((meta && Object.keys(meta).length > 0) ? { meta } : {}),
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
