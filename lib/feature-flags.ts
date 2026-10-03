import { env } from "@/lib/env"

export function isFeatureEnabled(flag: keyof typeof env): boolean {
  return env[flag] === true
}

export function assertFeatureEnabled(flag: keyof typeof env, featureName: string) {
  if (!isFeatureEnabled(flag)) {
    return {
      error: `${featureName} is not available`,
      status: 403
    }
  }
  return null
}
