import { prisma } from "@/lib/db/client"
import { getEnvNumber } from "@/lib/env"

const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_MINUTE = Math.max(
  1,
  Math.round(getEnvNumber(6, "AI_RATE_LIMIT_PER_MINUTE", "GENERATE_RATE_LIMIT_PER_MINUTE"))
)
const MAX_REQUESTS_PER_DAY = Math.max(
  MAX_REQUESTS_PER_MINUTE,
  Math.round(getEnvNumber(500, "AI_RATE_LIMIT_PER_DAY", "GENERATE_RATE_LIMIT_PER_DAY"))
)

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

export function enforceUserRateLimit(userId: string) {
  const now = Date.now()
  const current = buckets.get(userId)

  if (!current || current.resetAt <= now) {
    buckets.set(userId, {
      count: 1,
      resetAt: now + WINDOW_MS,
    })
    return
  }

  if (current.count >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} requests per minute.`)
  }

  current.count += 1
  buckets.set(userId, current)
}

export async function enforceAiUsageRateLimit(userId: string) {
  enforceUserRateLimit(userId)

  const now = new Date()
  const oneMinuteAgo = new Date(now.getTime() - WINDOW_MS)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [minuteCount, dayCount] = await Promise.all([
    prisma.usageLog.count({
      where: {
        userId,
        createdAt: {
          gte: oneMinuteAgo,
        },
      },
    }),
    prisma.usageLog.count({
      where: {
        userId,
        createdAt: {
          gte: oneDayAgo,
        },
      },
    }),
  ])

  if (minuteCount >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded. Maximum ${MAX_REQUESTS_PER_MINUTE} paid prompts per minute.`)
  }

  if (dayCount >= MAX_REQUESTS_PER_DAY) {
    throw new Error(`Daily limit exceeded. Maximum ${MAX_REQUESTS_PER_DAY} paid prompts per day.`)
  }
}

export const aiRateLimitConfig = {
  perMinute: MAX_REQUESTS_PER_MINUTE,
  perDay: MAX_REQUESTS_PER_DAY,
}
