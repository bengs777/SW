import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/db/client"
import { env } from "@/lib/env"
import { BillingService } from "@/lib/services/billing.service"
import { PakasirService } from "@/lib/services/pakasir.service"

type PakasirWebhookBody = Record<string, unknown> & {
  order_id?: string
  orderId?: string
  reference?: string
  status?: string
  amount?: number | string
  project?: string
  payment_method?: string
  paymentMethod?: string
  completed_at?: string
  completedAt?: string
  payment_code?: string
  paymentCode?: string
  payment_number?: string
  paymentNumber?: string
  payload?: Record<string, unknown>
}

type TransactionDetailResult = Awaited<ReturnType<typeof PakasirService.getTransactionDetail>>

function normalizeStatus(value: string | null | undefined) {
  const normalized = (value || "").toLowerCase().trim()

  if (["paid", "success", "settled", "settlement", "completed", "complete", "capture"].includes(normalized)) {
    return "paid"
  }

  if (["pending", "processing", "waiting", "unpaid"].includes(normalized)) {
    return "pending"
  }

  if (["failed", "expired", "cancelled", "canceled", "void", "denied"].includes(normalized)) {
    return normalized === "expired" ? "expired" : "failed"
  }

  return normalized || "pending"
}

function extractOrderId(body: PakasirWebhookBody) {
  return (
    body.order_id ||
    body.orderId ||
    body.reference ||
    (typeof body.payload?.order_id === "string" ? body.payload.order_id : undefined) ||
    (typeof body.payload?.orderId === "string" ? body.payload.orderId : undefined)
  )
}

function extractProject(body: PakasirWebhookBody) {
  return body.project || (typeof body.payload?.project === "string" ? body.payload.project : undefined)
}

function extractAmount(body: PakasirWebhookBody) {
  const rawAmount = body.amount ?? body.payload?.amount ?? body.payload?.total_amount ?? body.payload?.gross_amount
  const parsed = typeof rawAmount === "string" ? Number(rawAmount) : rawAmount
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.round(parsed) : null
}

function extractPaymentCode(body: PakasirWebhookBody) {
  return (
    (typeof body.payment_code === "string" && body.payment_code) ||
    (typeof body.paymentCode === "string" && body.paymentCode) ||
    (typeof body.payment_number === "string" && body.payment_number) ||
    (typeof body.paymentNumber === "string" && body.paymentNumber) ||
    (typeof body.payload?.payment_code === "string" ? body.payload.payment_code : undefined) ||
    (typeof body.payload?.payment_number === "string" ? body.payload.payment_number : undefined) ||
    null
  )
}

function looksPaid(status: string) {
  return status === "paid"
}

function pendingVerificationStatus(status: string) {
  return looksPaid(status) ? "verification_failed" : status
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  let body: PakasirWebhookBody
  try {
    body = JSON.parse(rawBody) as PakasirWebhookBody
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 })
  }

  const orderId = extractOrderId(body)
  if (!orderId) {
    return NextResponse.json({ error: "Missing order_id" }, { status: 400 })
  }

  const project = extractProject(body)
  if (env.pakasirSlug && project && project !== env.pakasirSlug) {
    return NextResponse.json({ error: "Project mismatch" }, { status: 409 })
  }

  const status = normalizeStatus(body.status)
  const amount = extractAmount(body)

  const order = await prisma.topUpOrder.findUnique({
    where: { reference: orderId },
    select: {
      reference: true,
      amount: true,
      status: true,
      providerReference: true,
      paymentCode: true,
    },
  })

  if (!order) {
    return NextResponse.json({ error: "Top up order not found" }, { status: 404 })
  }

  if (amount != null && amount !== order.amount) {
    return NextResponse.json({ error: "Amount mismatch" }, { status: 409 })
  }

  if (status === "pending") {
    await BillingService.updateTopUpOrder(order.reference, {
      status,
      response: rawBody,
      providerReference: order.providerReference ?? undefined,
      paymentCode: order.paymentCode ?? undefined,
    }).catch(() => undefined)

    return NextResponse.json({
      success: true,
      status: "pending",
      reference: order.reference,
    })
  }

  if (status === "failed" || status === "expired") {
    await BillingService.updateTopUpOrder(order.reference, {
      status,
      response: rawBody,
      providerReference: order.providerReference ?? undefined,
      paymentCode: order.paymentCode ?? undefined,
    }).catch(() => undefined)

    return NextResponse.json({
      success: true,
      status,
      reference: order.reference,
    })
  }

  let verification: TransactionDetailResult | null = null

  try {
    verification = await PakasirService.getTransactionDetail({
      reference: order.reference,
      amount: amount ?? order.amount,
    })
  } catch (error) {
    console.warn("[billing] Failed to verify Pakasir transaction", error)
  }

  const apiConfirmed = Boolean(
    verification?.isPaid &&
      verification.amount === order.amount &&
      verification.orderId === order.reference
  )

  if (!apiConfirmed) {
    const nextStatus = pendingVerificationStatus(verification?.status || status)

    await BillingService.updateTopUpOrder(order.reference, {
      status: nextStatus,
      response: rawBody,
      providerReference: verification?.providerReference ?? order.providerReference ?? undefined,
      paymentCode: verification?.paymentCode ?? order.paymentCode ?? undefined,
    }).catch(() => undefined)

    return NextResponse.json({
      success: true,
      status: nextStatus,
      reference: order.reference,
      verified: false,
    })
  }

  const finalized = await BillingService.finalizeTopUpOrder({
    reference: order.reference,
    providerReference: verification?.providerReference ?? order.providerReference ?? undefined,
    paymentCode: verification?.paymentCode ?? extractPaymentCode(body) ?? order.paymentCode ?? undefined,
    response: rawBody,
    amount: verification?.amount ?? amount ?? order.amount,
    paidAt: verification?.completedAt ? new Date(verification.completedAt) : new Date(),
  })

  return NextResponse.json({
    success: true,
    status: "paid",
    reference: order.reference,
    verified: Boolean(verification?.isPaid),
    alreadyProcessed: finalized.alreadyProcessed,
    creditedBalance: finalized.creditedBalance,
  })
}
