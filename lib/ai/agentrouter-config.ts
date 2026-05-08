import { env } from "@/lib/env"

export const AGENTROUTER_BASE_URL = "https://agentrouter.org/v1"
export const AGENTROUTER_PROVIDER = "agentrouter"
export const AGENTROUTER_PUBLIC_NAME = "AgentRouter"

export function getAgentRouterConfig() {
  return {
    apiKey: env.agentRouterApiKey,
    baseUrl: env.agentRouterApiUrl || AGENTROUTER_BASE_URL,
    provider: AGENTROUTER_PROVIDER,
    publicName: AGENTROUTER_PUBLIC_NAME,
  }
}

export function assertAgentRouterReady() {
  const config = getAgentRouterConfig()

  if (!config.apiKey) {
    throw new Error("AGENTROUTER_API_KEY is not configured")
  }

  return config
}
