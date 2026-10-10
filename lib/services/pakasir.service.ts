import { env, isConfiguredSecret } from "@/lib/env"

const PAKASIR_BASE_URL = "https://app.pakasir.com"

export class PakasirConfigurationError extends Error {
  readonly status = 503
  constructor(message = "Payment provider is not configured.") {
    super(message)
    this.name = "PakasirConfigurationError"
  }
}

export class PakasirTimeoutError extends Error {
  readonly status = 504
  constructor(message = "Payment provider request timed out.") {
    super(message)
    this.name = "PakasirTimeoutError"
  }
}

export class PakasirUnavailableError extends Error {
  readonly status = 503
  constructor(message = "Payment provider is currently unavailable.") {
    super(message)
    this.name = "PakasirUnavailableError"
  }
}

export class PakasirUpstreamError extends Error {
  readonly upstreamStatus: number
  constructor(message: string, upstreamStatus: number) {
    super(message)
    this.name = "PakasirUpstreamError"
    this.upstreamStatus = upstreamStatus
  }
}

type CreatePakasirInvoiceInput = {
  reference: string
  amount: number
  customerName: string
  customerEmail: string
  description: string
  webhookUrl: string
  returnUrl: string
  expiresAt?: Date
}

type CreatePakasirInvoiceResult = {
  checkoutUrl: string
  providerReference: string | null
  paymentCode: string | null
  paymentMethod: string | null
  rawResponse: string
}

type TransactionDetailInput = {
  reference: string
  amount: number
}

type TransactionDetailResult = {
  isPaid: boolean
  status: string
  orderId: string | null
  project: string | null
  amount: number | null
  paymentMethod: string | null
  paymentCode: string | null
  completedAt: string | null
  providerReference: string | null
  rawResponse: string
}

function readFirstString(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") {
    return null
  }

  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function readFirstObject(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") {
    return null
  }

  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }

  return null
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value)
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.round(parsed)
    }
  }

  return null
}

function parseJson(raw: string) {
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function getPakasirConfig() {
  let slug = env.pakasirSlug
  let apiKey = env.pakasirApiKey
  let webhookSecret = env.pakasirWebhookSecret

  if (!isConfiguredSecret(slug) || !isConfiguredSecret(apiKey)) {
    try {
      // Runtime fallback to read .env.local without requiring full server restart
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs")
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path")
      const envPath = path.resolve(process.cwd(), ".env.local")
      if (fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, "utf8")
        const matchSlug = raw.match(/^\s*PAKASIR_SLUG\s*=\s*(.+)$/m)
        const matchKey = raw.match(/^\s*PAKASIR_API_KEY\s*=\s*(.+)$/m)
        const matchSecret = raw.match(/^\s*PAKASIR_WEBHOOK_SECRET\s*=\s*(.+)$/m)
        if (matchSlug && matchSlug[1]) {
          slug = matchSlug[1].trim().replace(/^["']|["']$/g, "")
          process.env.PAKASIR_SLUG = slug
          env.pakasirSlug = slug
        }
        if (matchKey && matchKey[1]) {
          apiKey = matchKey[1].trim().replace(/^["']|["']$/g, "")
          process.env.PAKASIR_API_KEY = apiKey
          env.pakasirApiKey = apiKey
        }
        if (matchSecret && matchSecret[1]) {
          webhookSecret = matchSecret[1].trim().replace(/^["']|["']$/g, "")
          process.env.PAKASIR_WEBHOOK_SECRET = webhookSecret
          env.pakasirWebhookSecret = webhookSecret
        }
      }
    } catch {
      // ignore
    }
  }

  return { slug, apiKey, webhookSecret }
}

function buildCheckoutUrl(reference: string, amount: number, returnUrl: string) {
  const { slug } = getPakasirConfig()
  const url = new URL(`${PAKASIR_BASE_URL}/pay/${encodeURIComponent(slug)}/${amount}`)
  url.searchParams.set("order_id", reference)
  url.searchParams.set("qris_only", "1")

  if (returnUrl.trim()) {
    url.searchParams.set("redirect", returnUrl)
  }

  return url.toString()
}

function buildTransactionDetailUrl(reference: string, amount: number) {
  const { slug, apiKey } = getPakasirConfig()
  const url = new URL(`${PAKASIR_BASE_URL}/api/transactiondetail`)
  url.searchParams.set("project", slug)
  url.searchParams.set("amount", String(amount))
  url.searchParams.set("order_id", reference)
  url.searchParams.set("api_key", apiKey)
  return url.toString()
}

function isCompletedStatus(status: string) {
  const normalized = status.toLowerCase().trim()
  return ["completed", "paid", "success", "settled", "settlement", "capture"].includes(normalized)
}

export class PakasirService {
  static getConfig() {
    return getPakasirConfig()
  }

  static isConfigured(): boolean {
    const { slug, apiKey } = getPakasirConfig()
    return isConfiguredSecret(slug) && isConfiguredSecret(apiKey)
  }

  static async createInvoice(input: CreatePakasirInvoiceInput): Promise<CreatePakasirInvoiceResult> {
    const { slug, apiKey } = getPakasirConfig()
    if (!isConfiguredSecret(slug) || !isConfiguredSecret(apiKey)) {
      throw new PakasirConfigurationError("PAKASIR_SLUG and PAKASIR_API_KEY are required and must not be placeholders.")
    }

    let response: Response
    try {
      response = await fetch(`${PAKASIR_BASE_URL}/api/transactioncreate/qris`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          project: slug,
          order_id: input.reference,
          amount: input.amount,
          api_key: apiKey,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      })
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.name === "TimeoutError" || err.name === "AbortError" || /timeout/i.test(err.message)) {
          throw new PakasirTimeoutError("Payment provider request timed out.")
        }
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(err.message)) {
          throw new PakasirUnavailableError("Payment provider is unreachable.")
        }
      }
      throw new PakasirUnavailableError("Failed to connect to payment provider.")
    }

    const rawResponse = await response.text().catch(() => "")
    const json = parseJson(rawResponse)

    if (!response.ok) {
      const errorMessage =
        readFirstString(json, ["message", "error", "detail"]) ||
        `Pakasir request failed (${response.status})`
      throw new PakasirUpstreamError(errorMessage, response.status)
    }

    const payment = readFirstObject(json, ["payment", "transaction", "data"]) ?? json

    const providerReference =
      readFirstString(payment, ["id", "transaction_id", "transactionId", "reference", "order_id", "orderId"]) ||
      input.reference

    const paymentCode =
      readFirstString(payment, ["payment_number", "paymentNumber", "va_number", "vaNumber", "qr_string", "qrString"]) ||
      readFirstString(readFirstObject(payment, ["payment"]), ["payment_number", "paymentNumber", "va_number", "vaNumber", "qr_string", "qrString"])

    const paymentMethod = readFirstString(payment, ["payment_method", "paymentMethod"])

    return {
      checkoutUrl:
        readFirstString(payment, ["checkout_url", "checkoutUrl", "payment_url", "paymentUrl", "url"]) ||
        buildCheckoutUrl(input.reference, input.amount, input.returnUrl),
      providerReference,
      paymentCode,
      paymentMethod,
      rawResponse,
    }
  }

  static async getTransactionDetail(input: TransactionDetailInput): Promise<TransactionDetailResult> {
    if (!this.isConfigured()) {
      throw new PakasirConfigurationError("PAKASIR_SLUG and PAKASIR_API_KEY are required and must not be placeholders.")
    }

    let response: Response
    try {
      response = await fetch(buildTransactionDetailUrl(input.reference, input.amount), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      })
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.name === "TimeoutError" || err.name === "AbortError" || /timeout/i.test(err.message)) {
          throw new PakasirTimeoutError("Payment provider request timed out.")
        }
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(err.message)) {
          throw new PakasirUnavailableError("Payment provider is unreachable.")
        }
      }
      throw new PakasirUnavailableError("Failed to connect to payment provider.")
    }

    const rawResponse = await response.text().catch(() => "")
    const json = parseJson(rawResponse)

    if (!response.ok) {
      const errorMessage =
        readFirstString(json, ["message", "error", "detail"]) ||
        `Pakasir transaction detail failed (${response.status})`
      throw new PakasirUpstreamError(errorMessage, response.status)
    }

    const transaction = readFirstObject(json, ["transaction", "data"]) ?? json
    const status = readFirstString(transaction, ["status"]) || "pending"
    const amount = toNumber((transaction as Record<string, unknown> | null)?.amount) ?? input.amount

    return {
      isPaid: isCompletedStatus(status),
      status,
      orderId:
        readFirstString(transaction, ["order_id", "orderId", "reference"]) || input.reference,
      project: readFirstString(transaction, ["project"]) || getPakasirConfig().slug,
      amount,
      paymentMethod: readFirstString(transaction, ["payment_method", "paymentMethod"]),
      paymentCode:
        readFirstString(transaction, ["payment_number", "paymentNumber", "va_number", "vaNumber", "qr_string", "qrString"]) ||
        readFirstString(readFirstObject(transaction, ["payment"]), ["payment_number", "paymentNumber", "va_number", "vaNumber", "qr_string", "qrString"]),
      completedAt:
        readFirstString(transaction, ["completed_at", "completedAt", "paid_at", "paidAt"]) ||
        null,
      providerReference:
        readFirstString(transaction, ["id", "transaction_id", "transactionId", "reference", "order_id", "orderId"]) ||
        input.reference,
      rawResponse,
    }
  }
}