import { env } from "@/lib/env"

const PAKASIR_BASE_URL = "https://app.pakasir.com"

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

function buildCheckoutUrl(reference: string, amount: number, returnUrl: string) {
  const url = new URL(`${PAKASIR_BASE_URL}/pay/${encodeURIComponent(env.pakasirSlug)}/${amount}`)
  url.searchParams.set("order_id", reference)
  url.searchParams.set("qris_only", "1")

  if (returnUrl.trim()) {
    url.searchParams.set("redirect", returnUrl)
  }

  return url.toString()
}

function buildTransactionDetailUrl(reference: string, amount: number) {
  const url = new URL(`${PAKASIR_BASE_URL}/api/transactiondetail`)
  url.searchParams.set("project", env.pakasirSlug)
  url.searchParams.set("amount", String(amount))
  url.searchParams.set("order_id", reference)
  url.searchParams.set("api_key", env.pakasirApiKey)
  return url.toString()
}

function isCompletedStatus(status: string) {
  const normalized = status.toLowerCase().trim()
  return ["completed", "paid", "success", "settled", "settlement", "capture"].includes(normalized)
}

export class PakasirService {
  static async createInvoice(input: CreatePakasirInvoiceInput): Promise<CreatePakasirInvoiceResult> {
    if (!env.pakasirSlug || !env.pakasirApiKey) {
      throw new Error("PAKASIR_SLUG and PAKASIR_API_KEY are required")
    }

    const response = await fetch(`${PAKASIR_BASE_URL}/api/transactioncreate/qris`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        project: env.pakasirSlug,
        order_id: input.reference,
        amount: input.amount,
        api_key: env.pakasirApiKey,
      }),
      cache: "no-store",
    })

    const rawResponse = await response.text().catch(() => "")
    const json = parseJson(rawResponse)

    if (!response.ok) {
      const errorMessage =
        readFirstString(json, ["message", "error", "detail"]) ||
        rawResponse ||
        `Pakasir request failed (${response.status})`
      throw new Error(errorMessage)
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
    if (!env.pakasirSlug || !env.pakasirApiKey) {
      throw new Error("PAKASIR_SLUG and PAKASIR_API_KEY are required")
    }

    const response = await fetch(buildTransactionDetailUrl(input.reference, input.amount), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    })

    const rawResponse = await response.text().catch(() => "")
    const json = parseJson(rawResponse)

    if (!response.ok) {
      const errorMessage =
        readFirstString(json, ["message", "error", "detail"]) ||
        rawResponse ||
        `Pakasir transaction detail failed (${response.status})`
      throw new Error(errorMessage)
    }

    const transaction = readFirstObject(json, ["transaction", "data"]) ?? json
    const status = readFirstString(transaction, ["status"]) || "pending"
    const amount = toNumber((transaction as Record<string, unknown> | null)?.amount) ?? input.amount

    return {
      isPaid: isCompletedStatus(status),
      status,
      orderId:
        readFirstString(transaction, ["order_id", "orderId", "reference"]) || input.reference,
      project: readFirstString(transaction, ["project"]) || env.pakasirSlug,
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