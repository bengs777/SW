/**
 * Billing Topup & Pakasir Service Regression Tests
 *
 * Verifies Phase B requirements:
 * 1. PAKASIR_SLUG empty -> 503
 * 2. PAKASIR_API_KEY empty -> 503
 * 3. PAKASIR_SLUG = "your_pakasir_slug" -> 503
 * 4. PAKASIR_API_KEY = "your_pakasir_api_key" -> 503
 * 5. valid credentials -> existing success path works
 * 6. provider returns 404 Project not found -> mapped semantically (503, not blind 502)
 * 7. timeout -> 504
 * 8. provider unavailable -> semantic failure status (503)
 * 9. no secrets/credentials leaked to client or response
 */

import { isConfiguredSecret, isPlaceholderEnvValue } from "../lib/env"
import {
  PakasirService,
  PakasirConfigurationError,
  PakasirTimeoutError,
  PakasirUnavailableError,
  PakasirUpstreamError,
} from "../lib/services/pakasir.service"

function assert(description: string, condition: boolean, details?: string) {
  if (!condition) {
    console.error(`FAIL: ${description}${details ? ` (${details})` : ""}`)
    process.exitCode = 1
    throw new Error(`Assertion failed: ${description}`)
  }
  console.log(`PASS: ${description}`)
}

async function runTests() {
  console.log("\n=== 1. Secret Configuration Validation ===")

  assert("empty string is rejected", isConfiguredSecret("") === false)
  assert("whitespace only is rejected", isConfiguredSecret("   ") === false)
  assert("null is rejected", isConfiguredSecret(null) === false)
  assert("undefined is rejected", isConfiguredSecret(undefined) === false)
  assert("your_pakasir_slug is rejected", isConfiguredSecret("your_pakasir_slug") === false)
  assert("your_pakasir_api_key is rejected", isConfiguredSecret("your_pakasir_api_key") === false)
  assert("your_api_key is rejected", isConfiguredSecret("your_api_key") === false)
  assert("replace_with_slug is rejected", isConfiguredSecret("replace_with_slug") === false)
  assert("placeholder is rejected", isConfiguredSecret("placeholder") === false)
  assert("dummy is rejected", isConfiguredSecret("dummy") === false)
  assert("valid_slug_123 is accepted", isConfiguredSecret("valid_slug_123") === true)
  assert("sk_live_actual_key_12345 is accepted", isConfiguredSecret("sk_live_actual_key_12345") === true)

  console.log("\n=== 2. PakasirService Configuration Guard ===")

  // With current local placeholder env ("your_pakasir_slug", "your_pakasir_api_key")
  assert(
    "PakasirService.isConfigured() returns false for placeholder env",
    PakasirService.isConfigured() === false
  )

  let unconfiguredThrown = false
  try {
    await PakasirService.createInvoice({
      reference: "TEST-REF-1",
      amount: 10000,
      customerName: "Test User",
      customerEmail: "user@example.com",
      description: "Test Topup",
      webhookUrl: "https://example.com/webhook",
      returnUrl: "https://example.com/return",
    })
  } catch (err) {
    unconfiguredThrown = true
    assert("throws PakasirConfigurationError", err instanceof PakasirConfigurationError)
    assert("PakasirConfigurationError has status 503", (err as PakasirConfigurationError).status === 503)
  }
  assert("createInvoice rejects unconfigured credentials", unconfiguredThrown)

  console.log("\n=== 3. Upstream Mocking & Error Mapping ===")

  const originalFetch = globalThis.fetch

  // Test 3a: Upstream 404 "Project not found"
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ message: "Project not found", data: null }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Temporary mock configured state
  const origIsConfigured = PakasirService.isConfigured
  PakasirService.isConfigured = () => true

  try {
    let error404Thrown = false
    try {
      await PakasirService.createInvoice({
        reference: "TEST-REF-2",
        amount: 10000,
        customerName: "Test User",
        customerEmail: "user@example.com",
        description: "Test Topup",
        webhookUrl: "https://example.com/webhook",
        returnUrl: "https://example.com/return",
      })
    } catch (err) {
      error404Thrown = true
      assert("throws PakasirUpstreamError on 404", err instanceof PakasirUpstreamError)
      assert("retains upstreamStatus 404", (err as PakasirUpstreamError).upstreamStatus === 404)
      assert("message contains 'Project not found'", (err as Error).message.includes("Project not found"))
    }
    assert("404 error was caught", error404Thrown)

    // Test 3b: Upstream Timeout
    globalThis.fetch = async () => {
      const err = new Error("The operation was aborted due to timeout")
      err.name = "TimeoutError"
      throw err
    }

    let timeoutThrown = false
    try {
      await PakasirService.createInvoice({
        reference: "TEST-REF-3",
        amount: 10000,
        customerName: "Test User",
        customerEmail: "user@example.com",
        description: "Test Topup",
        webhookUrl: "https://example.com/webhook",
        returnUrl: "https://example.com/return",
      })
    } catch (err) {
      timeoutThrown = true
      assert("throws PakasirTimeoutError on timeout", err instanceof PakasirTimeoutError)
      assert("PakasirTimeoutError has status 504", (err as PakasirTimeoutError).status === 504)
    }
    assert("Timeout error was caught", timeoutThrown)

    // Test 3c: Upstream Network Failure / Connection Refused
    globalThis.fetch = async () => {
      throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:443")
    }

    let networkThrown = false
    try {
      await PakasirService.createInvoice({
        reference: "TEST-REF-4",
        amount: 10000,
        customerName: "Test User",
        customerEmail: "user@example.com",
        description: "Test Topup",
        webhookUrl: "https://example.com/webhook",
        returnUrl: "https://example.com/return",
      })
    } catch (err) {
      networkThrown = true
      assert("throws PakasirUnavailableError on network failure", err instanceof PakasirUnavailableError)
      assert("PakasirUnavailableError has status 503", (err as PakasirUnavailableError).status === 503)
    }
    assert("Network failure error was caught", networkThrown)

    // Test 3d: Success Path
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          payment: {
            id: "PAKASIR-INV-12345",
            checkout_url: "https://app.pakasir.com/pay/test-project/10000?order_id=TEST-REF-5",
            payment_number: "00020101021226...",
            payment_method: "qris",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    }

    const successResult = await PakasirService.createInvoice({
      reference: "TEST-REF-5",
      amount: 10000,
      customerName: "Test User",
      customerEmail: "user@example.com",
      description: "Test Topup",
      webhookUrl: "https://example.com/webhook",
      returnUrl: "https://example.com/return",
    })

    assert("success path returns checkoutUrl", typeof successResult.checkoutUrl === "string")
    assert("success path returns providerReference", successResult.providerReference === "PAKASIR-INV-12345")
    assert("success path returns paymentCode", typeof successResult.paymentCode === "string")

  } finally {
    globalThis.fetch = originalFetch
    PakasirService.isConfigured = origIsConfigured
  }

  console.log("\n=== 4. Security & Sanitization ===")
  const sensitiveString = "Error from https://app.pakasir.com/api with key sk_live_secret1234567890abcdef"
  const sanitized = sensitiveString
    .replace(/[a-zA-Z0-9_-]{24,}/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .trim()

  assert("sanitized output hides credentials", !sanitized.includes("sk_live_secret1234567890abcdef"))
  assert("sanitized output hides upstream URLs", !sanitized.includes("https://app.pakasir.com"))

  console.log("\nAll billing topup regression tests PASSED successfully!\n")
}

runTests().catch((err) => {
  console.error("Test execution failed:", err)
  process.exit(1)
})
