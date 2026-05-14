import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "@/lib/env"

/**
 * Webhook signature verification for Pakasir payment webhooks.
 *
 * Verifies the authenticity of incoming webhook requests using HMAC-SHA256.
 * Falls back to IP-based verification and API confirmation if signature header is not present.
 */

const SIGNATURE_HEADER = "x-pakasir-signature"
const TIMESTAMP_HEADER = "x-pakasir-timestamp"
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Compute HMAC-SHA256 signature for webhook payload.
 * The signing key is the Pakasir API key.
 */
function computeSignature(payload: string, timestamp: string): string {
  const secret = env.pakasirApiKey
  if (!secret) {
    throw new Error("PAKASIR_API_KEY is required for webhook signature verification")
  }

  // Sign: timestamp + "." + rawBody
  const signedPayload = `${timestamp}.${payload}`
  return createHmac("sha256", secret).update(signedPayload).digest("hex")
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  } catch {
    return false
  }
}

export type WebhookVerificationResult = {
  verified: boolean
  method: "signature" | "api_confirmation" | "development_bypass"
  reason?: string
}

/**
 * Verify webhook signature from Pakasir.
 *
 * Strategy:
 * 1. If signature header exists → verify HMAC-SHA256
 * 2. If no signature header but in production → reject unless API confirmation passes
 * 3. In development → allow with warning (for testing)
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Headers
): WebhookVerificationResult {
  const signature = headers.get(SIGNATURE_HEADER)
  const timestamp = headers.get(TIMESTAMP_HEADER)

  // Development bypass (only in non-production)
  if (process.env.NODE_ENV !== "production" && !signature) {
    console.warn("[webhook-security] Signature verification bypassed in development mode")
    return { verified: true, method: "development_bypass" }
  }

  // If signature header is present, verify it
  if (signature && timestamp) {
    // Check timestamp freshness to prevent replay attacks
    const timestampMs = Number(timestamp) * 1000
    if (!Number.isFinite(timestampMs)) {
      return {
        verified: false,
        method: "signature",
        reason: "Invalid timestamp format",
      }
    }

    const age = Math.abs(Date.now() - timestampMs)
    if (age > MAX_TIMESTAMP_AGE_MS) {
      return {
        verified: false,
        method: "signature",
        reason: `Timestamp too old (${Math.round(age / 1000)}s ago, max ${MAX_TIMESTAMP_AGE_MS / 1000}s)`,
      }
    }

    // Compute and compare signature
    try {
      const expectedSignature = computeSignature(rawBody, timestamp)
      const isValid = safeCompare(signature, expectedSignature)

      return {
        verified: isValid,
        method: "signature",
        reason: isValid ? undefined : "Signature mismatch",
      }
    } catch (error) {
      return {
        verified: false,
        method: "signature",
        reason: error instanceof Error ? error.message : "Signature computation failed",
      }
    }
  }

  // No signature header in production: rely on API confirmation
  // The webhook handler MUST call PakasirService.getTransactionDetail() to verify
  // This is a defense-in-depth approach
  if (process.env.NODE_ENV === "production") {
    return {
      verified: true,
      method: "api_confirmation",
      reason: "No signature header; payment will be verified via API confirmation before crediting",
    }
  }

  return { verified: true, method: "development_bypass" }
}

/**
 * Verify that the request comes from an expected IP range.
 * This is an additional layer; Pakasir should provide their IP ranges.
 */
export function verifyWebhookSourceIp(request: { headers: Headers }): boolean {
  // If PAKASIR_WEBHOOK_IPS is configured, enforce IP allowlist
  const allowedIps = process.env.PAKASIR_WEBHOOK_IPS
  if (!allowedIps) return true // Not configured = skip IP check

  const allowedList = allowedIps.split(",").map((ip) => ip.trim()).filter(Boolean)
  if (allowedList.length === 0) return true

  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    ""

  return allowedList.includes(clientIp)
}
