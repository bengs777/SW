type DbMetricState = {
  connectionFailures: number
  retries: number
  queryDurations: number[]
  poolUsageSamples: number[]
}

const MAX_SAMPLES = 500
const state: DbMetricState = {
  connectionFailures: 0,
  retries: 0,
  queryDurations: [],
  poolUsageSamples: [],
}

function pushSample(samples: number[], value: number) {
  samples.push(Math.max(0, Math.round(value)))
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function percentile(values: number[], pct: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1)
  return sorted[index]
}

export function recordDbQueryTime(durationMs: number) {
  pushSample(state.queryDurations, durationMs)
}

export function recordDbConnectionFailure() {
  state.connectionFailures += 1
}

export function recordDbRetry() {
  state.retries += 1
}

export function recordDbPoolUsage(value: number) {
  pushSample(state.poolUsageSamples, value)
}

export function getDatabaseMetricsSnapshot() {
  return {
    db_connection_failures: state.connectionFailures,
    db_connection_pool_usage: average(state.poolUsageSamples),
    db_retry_count: state.retries,
    average_query_time: average(state.queryDurations),
    P95_query_time: percentile(state.queryDurations, 95),
    samples: {
      query_count: state.queryDurations.length,
      pool_usage_count: state.poolUsageSamples.length,
    },
  }
}

export function renderDatabasePrometheusMetrics() {
  const snapshot = getDatabaseMetricsSnapshot()
  return [
    `db_connection_failures ${snapshot.db_connection_failures}`,
    `db_connection_pool_usage ${snapshot.db_connection_pool_usage}`,
    `db_retry_count ${snapshot.db_retry_count}`,
    `average_query_time ${snapshot.average_query_time}`,
    `P95_query_time ${snapshot.P95_query_time}`,
  ].join("\n")
}
