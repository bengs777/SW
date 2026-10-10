/**
 * Direct runtime verification of POST /api/billing/topup handler
 */

import { NextRequest } from "next/server"
import * as authModule from "@/auth"

// Mock getSession to simulate logged-in user
const origGetSession = authModule.getSession
;(authModule as any).getSession = async () => ({
  userId: "usr_test_verification_123",
  email: "dev@ai-swift.biz.id",
  name: "Swift Developer",
  image: null,
  roles: ["user", "developer"],
  role: "developer",
  isDeveloperAccount: true,
})

async function testRuntime() {
  const { POST } = await import("../app/api/billing/topup/route")

  console.log("\n--- Testing POST /api/billing/topup with placeholder credentials ---")
  const req = new NextRequest("http://localhost:3000/api/billing/topup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: 50000,
      note: "Topup test",
    }),
  })

  const res = await POST(req)
  const status = res.status
  const data = await res.json()

  console.log("HTTP Status:", status)
  console.log("Response Body:", JSON.stringify(data, null, 2))

  if (status !== 503) {
    throw new Error(`Expected HTTP 503, got ${status}`)
  }

  const rawJson = JSON.stringify(data)
  if (rawJson.includes("your_pakasir") || rawJson.includes("api_key") || rawJson.includes("secret")) {
    throw new Error("Secret or credential leaked in response!")
  }

  console.log("PASS: Response status is 503 Service Unavailable")
  console.log("PASS: No credentials or secrets exposed")
  console.log("Verification successful!\n")
}

testRuntime().catch((err) => {
  console.error("Runtime test failed:", err)
  process.exit(1)
})
