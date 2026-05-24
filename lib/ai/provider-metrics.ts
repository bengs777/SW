import type { ProviderAttemptLog } from "@/lib/ai/provider-router"

type TokenUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

const counters = {
  successes: 0,
  failures: 0,
  failovers: 0,
  latencyTotalMs: 0,
  latencySamples: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
}

function rate(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10
}

export function recordProviderAttemptMetric(attempt: ProviderAttemptLog) {
  if (attempt.status === "success") counters.successes += 1
  if (attempt.status === "failed") counters.failures += 1

  if (attempt.status !== "skipped" && attempt.latencyMs > 0) {
    counters.latencyTotalMs += attempt.latencyMs
    counters.latencySamples += 1
  }
}

export function recordProviderFailoverMetric() {
  counters.failovers += 1
}

export function recordProviderTokenUsageMetric(tokenUsage?: TokenUsage) {
  counters.promptTokens += Math.max(0, Math.round(tokenUsage?.promptTokens || 0))
  counters.completionTokens += Math.max(0, Math.round(tokenUsage?.completionTokens || 0))
  counters.totalTokens += Math.max(0, Math.round(tokenUsage?.totalTokens || 0))
}

export function getProviderMetricsSnapshot() {
  const total = counters.successes + counters.failures
  return {
    provider_success_rate: rate(counters.successes, total),
    provider_failure_rate: rate(counters.failures, total),
    failover_count: counters.failovers,
    average_latency: counters.latencySamples === 0 ? 0 : Math.round(counters.latencyTotalMs / counters.latencySamples),
    token_usage: {
      prompt_tokens: counters.promptTokens,
      completion_tokens: counters.completionTokens,
      total_tokens: counters.totalTokens,
    },
    attempts: {
      total,
      successes: counters.successes,
      failures: counters.failures,
    },
  }
}

export function renderProviderPrometheusMetrics() {
  const snapshot = getProviderMetricsSnapshot()
  return [
    `provider_success_rate ${snapshot.provider_success_rate}`,
    `provider_failure_rate ${snapshot.provider_failure_rate}`,
    `failover_count ${snapshot.failover_count}`,
    `average_latency ${snapshot.average_latency}`,
    `token_usage{type="prompt"} ${snapshot.token_usage.prompt_tokens}`,
    `token_usage{type="completion"} ${snapshot.token_usage.completion_tokens}`,
    `token_usage{type="total"} ${snapshot.token_usage.total_tokens}`,
  ].join("\n")
}
