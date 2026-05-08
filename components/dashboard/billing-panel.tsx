"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSession } from "next-auth/react"
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  Coins,
  Crown,
  ExternalLink,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { MIN_CRYPTO_PAYMENT_USD, MIN_CRYPTO_PAYMENT_USD_CENTS, TOPUP_MINIMUM_IDR, USD_TO_IDR } from "@/lib/billing/constants"
import {
  BILLING_PLANS,
  getBillingPlan,
  normalizeBillingPlanId,
  parseBillingOrderPayload,
  type BillingPlanId,
} from "@/lib/billing/plans"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { useCryptoPayment } from "@/hooks/use-crypto-payment"
import { OPEN_ALL_FEATURES_DURING_LAUNCH } from "@/lib/launch"

type BillingOverview = {
  balance: number
  welcomeBonusGrantedAt: string | null
  welcomeBonusAmount: number
  topupMinimum: number
  topUpOrders: Array<{
    id: string
    reference: string
    amount: number
    status: string
    provider: string
    providerReference: string | null
    checkoutUrl: string | null
    paymentCode: string | null
    customerName: string | null
    customerEmail: string | null
    payload: string | null
    createdAt: string
    paidAt: string | null
    expiresAt: string | null
  }>
  billingTransactions: Array<{
    id: string
    kind: string
    direction: string
    amount: number
    balanceBefore: number
    balanceAfter: number
    reference: string | null
    provider: string | null
    providerReference: string | null
    description: string | null
    createdAt: string
  }>
}

type WorkspaceOption = {
  workspace: {
    id: string
    name: string
    slug: string
    subscription: {
      plan: string
      status: string
      tokensLimit: number
      tokensUsed: number
      renewalDate: string | null
    } | null
  }
}

const QUICK_AMOUNTS = [2000, 5000, 10000, 25000]

function formatCurrency(value: number) {
  return `Rp ${value.toLocaleString("id-ID")}`
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-"
  }

  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function statusVariant(status: string) {
  switch (status.toLowerCase()) {
    case "paid":
      return "default"
    case "pending":
    case "processing":
      return "secondary"
    case "failed":
    case "expired":
    case "canceled":
    case "cancelled":
      return "destructive"
    default:
      return "outline"
  }
}

export function BillingPanel() {
  const { status: sessionStatus } = useSession()
  const { toast } = useToast()
  const { createPaymentRequest: createCryptoCheckout, openCheckout: openCryptoCheckout, isLoading: isCryptoLoading } = useCryptoPayment()
  
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [amount, setAmount] = useState("2000")
  const [error, setError] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [lastCheckoutUrl, setLastCheckoutUrl] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<"pakasir" | "crypto">("pakasir")
  const [selectedChain, setSelectedChain] = useState<56 | 8453>(56)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const cryptoMinimumLabel = `Rp ${TOPUP_MINIMUM_IDR.toLocaleString("id-ID")} (~${MIN_CRYPTO_PAYMENT_USD.toFixed(2)} USDT)`

  const activeWorkspace = useMemo(() => {
    if (!selectedWorkspaceId) {
      return workspaces[0] || null
    }

    return workspaces.find((workspace) => workspace.workspace.id === selectedWorkspaceId) || workspaces[0] || null
  }, [selectedWorkspaceId, workspaces])

  const activeSubscription = activeWorkspace?.workspace.subscription || null
  const isLaunchMode = OPEN_ALL_FEATURES_DURING_LAUNCH
  const activePlan = isLaunchMode ? getBillingPlan("studio") : getBillingPlan(activeSubscription?.plan)
  const activePlanId = isLaunchMode ? "studio" : normalizeBillingPlanId(activeSubscription?.plan)

  const topUpOrders = useMemo(() => overview?.topUpOrders || [], [overview?.topUpOrders])
  const balanceTopUpOrders = useMemo(
    () => topUpOrders.filter((order) => parseBillingOrderPayload(order.payload)?.purchaseType !== "subscription"),
    [topUpOrders]
  )
  const subscriptionOrders = useMemo(
    () => topUpOrders.filter((order) => parseBillingOrderPayload(order.payload)?.purchaseType === "subscription"),
    [topUpOrders]
  )

  const loadOverview = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/billing/overview", {
        cache: "no-store",
      })

      const data = (await response.json().catch(() => ({}))) as { error?: string } & Partial<BillingOverview>

      if (!response.ok) {
        throw new Error(data.error || "Failed to load billing overview")
      }

      setOverview({
        balance: data.balance || 0,
        welcomeBonusGrantedAt: data.welcomeBonusGrantedAt || null,
        welcomeBonusAmount: data.welcomeBonusAmount || 5000,
        topupMinimum: data.topupMinimum || TOPUP_MINIMUM_IDR,
        topUpOrders: Array.isArray(data.topUpOrders) ? data.topUpOrders : [],
        billingTransactions: Array.isArray(data.billingTransactions) ? data.billingTransactions : [],
      })
    } catch (loadError) {
      const messageText = loadError instanceof Error ? loadError.message : "Gagal memuat billing"
      setError(messageText)
      toast({
        title: "Gagal memuat billing",
        description: messageText,
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  const loadWorkspaces = useCallback(async () => {
    setIsWorkspaceLoading(true)
    setWorkspaceError(null)

    try {
      const response = await fetch("/api/workspaces", {
        cache: "no-store",
      })

      const data = (await response.json().catch(() => [])) as Array<WorkspaceOption> | { error?: string }

      if (!response.ok || !Array.isArray(data)) {
        const messageText = !Array.isArray(data) ? (data as { error?: string }).error || "Failed to load workspaces" : "Failed to load workspaces"
        throw new Error(messageText)
      }

      setWorkspaces(data)
      setSelectedWorkspaceId((current) => {
        if (current && data.some((workspace) => workspace.workspace.id === current)) {
          return current
        }

        return data[0]?.workspace.id || null
      })
    } catch (loadError) {
      const messageText = loadError instanceof Error ? loadError.message : "Gagal memuat workspace"
      setWorkspaceError(messageText)
    } finally {
      setIsWorkspaceLoading(false)
    }
  }, [])

  useEffect(() => {
    if (sessionStatus === "authenticated") {
      void loadOverview()
      void loadWorkspaces()
    }

    if (sessionStatus === "unauthenticated") {
      setIsLoading(false)
      setIsWorkspaceLoading(false)
      setError("Silakan login untuk melihat billing dan top up.")
    }
  }, [loadOverview, loadWorkspaces, sessionStatus])

  const handleCreateTopup = async () => {
    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount < TOPUP_MINIMUM_IDR) {
      setError(`Top up minimum adalah Rp ${TOPUP_MINIMUM_IDR.toLocaleString("id-ID")}.`)
      return
    }

    setIsSubmitting(true)
    setError(null)
    setMessage(null)

    try {
      const response = await fetch("/api/billing/topup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: parsedAmount,
          source: "billing-panel",
        }),
      })

      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        checkoutUrl?: string | null
        paymentCode?: string | null
        order?: {
          reference?: string
          amount?: number
          status?: string
        }
      }

      if (!response.ok) {
        throw new Error(data.error || "Gagal membuat top up")
      }

      const checkoutUrl = data.checkoutUrl || null
      setLastCheckoutUrl(checkoutUrl)
      setMessage(
        checkoutUrl
          ? `Order ${data.order?.reference || "top up"} siap dibayar via Pakasir.`
          : "Order top up dibuat, tetapi URL pembayaran belum tersedia."
      )

      toast({
        title: "Top up dibuat",
        description: checkoutUrl
          ? "Halaman pembayaran Pakasir akan dibuka."
          : "Order dibuat, cek detail di panel billing.",
      })

      await loadOverview()

      if (checkoutUrl) {
        window.open(checkoutUrl, "_blank", "noopener,noreferrer")
      }
    } catch (submitError) {
      const messageText = submitError instanceof Error ? submitError.message : "Gagal membuat top up"
      setError(messageText)
      toast({
        title: "Top up gagal",
        description: messageText,
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCreateCryptoTopup = async () => {
    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount < TOPUP_MINIMUM_IDR) {
      setError(`Minimum pembayaran crypto mengikuti ${cryptoMinimumLabel}.`)
      return
    }

    setIsSubmitting(true)
    setError(null)
    setMessage(null)

    try {
      const amountInUsd = Math.ceil((parsedAmount / USD_TO_IDR) * 100)

      if (amountInUsd < MIN_CRYPTO_PAYMENT_USD_CENTS) {
        setError(`Minimum pembayaran crypto mengikuti ${cryptoMinimumLabel}.`)
        return
      }

      await openCryptoCheckout(amountInUsd, selectedChain)

      const chainName = selectedChain === 56 ? "BNB Chain" : "Base"
      setMessage(`Payment link terbuka untuk ${chainName}`)

      setTimeout(() => {
        void loadOverview()
      }, 2000)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Gagal membuat crypto payment"
      setError(errorMsg)
      toast({
        title: "Crypto payment gagal",
        description: errorMsg,
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePurchasePlan = async (planId: BillingPlanId, method: "pakasir" | "crypto") => {
    const plan = BILLING_PLANS.find((item) => item.id === planId)

    if (!plan || plan.id === "free") {
      setMessage("Plan Free sudah termasuk dan tidak perlu dibeli.")
      return
    }

    if (!activeWorkspace) {
      setError("Pilih workspace aktif sebelum membeli paket.")
      return
    }

    setIsSubmitting(true)
    setError(null)
    setMessage(null)

    const payload = {
      amount: plan.priceIdr,
      source: "billing-panel",
      note: `Purchase ${plan.name} plan`,
      purchaseType: "subscription" as const,
      planId: plan.id,
      workspaceId: activeWorkspace.workspace.id,
    }

    try {
      if (method === "pakasir") {
        const response = await fetch("/api/billing/topup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        })

        const data = (await response.json().catch(() => ({}))) as {
          error?: string
          checkoutUrl?: string | null
          paymentCode?: string | null
          order?: {
            reference?: string
            amount?: number
            status?: string
          }
        }

        if (!response.ok) {
          throw new Error(data.error || `Gagal membuat order ${plan.name}`)
        }

        const checkoutUrl = data.checkoutUrl || null
        setLastCheckoutUrl(checkoutUrl)
        setMessage(
          checkoutUrl
            ? `Order ${data.order?.reference || plan.name} siap dibayar via Pakasir.`
            : `Order ${plan.name} dibuat, tetapi URL pembayaran belum tersedia.`
        )

        toast({
          title: `${plan.name} dibuat`,
          description: checkoutUrl
            ? "Halaman pembayaran Pakasir akan dibuka."
            : "Order dibuat, cek detail di panel billing.",
        })

        if (checkoutUrl) {
          window.open(checkoutUrl, "_blank", "noopener,noreferrer")
        }
      } else {
        const amountInUsd = Math.ceil((plan.priceIdr / USD_TO_IDR) * 100)
        const paymentResponse = await createCryptoCheckout(amountInUsd, selectedChain, {
          purchaseType: "subscription",
          planId: plan.id,
          workspaceId: activeWorkspace.workspace.id,
          source: "billing-panel",
          note: `Purchase ${plan.name} plan`,
        })

        if (!paymentResponse) {
          throw new Error(`Gagal membuat crypto checkout untuk ${plan.name}`)
        }

        setLastCheckoutUrl(paymentResponse.checkoutUrl)
        setMessage(`Payment link terbuka untuk ${plan.name} via ${paymentResponse.chainName}`)

        toast({
          title: `${plan.name} dibuat`,
          description: "Checkout crypto akan terbuka.",
        })

        window.open(paymentResponse.checkoutUrl, "_blank", "noopener,noreferrer")
      }

      await Promise.all([loadOverview(), loadWorkspaces()])
    } catch (submitError) {
      const messageText = submitError instanceof Error ? submitError.message : `Gagal membeli ${plan.name}`
      setError(messageText)
      toast({
        title: "Pembelian paket gagal",
        description: messageText,
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const currentBalance = overview?.balance ?? 0
  const topupMinimum = overview?.topupMinimum ?? 2000
  const freeCreditsGranted = Boolean(overview?.welcomeBonusGrantedAt)

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="border-b border-border/70 bg-muted/20">
          <CardTitle className="flex items-center gap-2">
            <Crown className="h-5 w-5" />
            Paket dan workspace aktif
          </CardTitle>
          <CardDescription>
            Pilih workspace lalu beli Builder atau Studio untuk membuka fitur tambahan tanpa menghapus top up saldo yang sudah ada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 p-6">
          <div className="grid gap-4 lg:grid-cols-[0.9fr,1.1fr]">
            <div className="rounded-3xl border border-border/70 bg-background/70 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                    Workspace target
                  </div>
                  <h3 className="mt-1 text-lg font-semibold text-foreground">
                    {activeWorkspace?.workspace.name || "Belum ada workspace"}
                  </h3>
                </div>
                {activeWorkspace && (
                  <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
                    {activePlan.name}
                    {isLaunchMode && (
                      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                        Launch mode aktif: semua fitur dibuka sementara untuk QA dan pencarian bug.
                      </div>
                    )}
                  </Badge>
                )}
              </div>

              <div className="mt-4 space-y-2">
                <label className="text-sm font-medium text-foreground">Pilih workspace</label>
                <select
                  value={selectedWorkspaceId || ""}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value || null)}
                  className="w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground shadow-sm outline-none transition-colors focus:border-primary"
                  disabled={isWorkspaceLoading || workspaces.length === 0}
                >
                  {workspaces.length === 0 ? (
                    <option value="">Belum ada workspace</option>
                  ) : (
                    workspaces.map((workspace) => (
                      <option key={workspace.workspace.id} value={workspace.workspace.id}>
                        {workspace.workspace.name}
                      </option>
                    ))
                  )}
                </select>
                {workspaceError && (
                  <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {workspaceError}
                  </div>
                )}
                {isWorkspaceLoading && (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                    Memuat workspace...
                  </div>
                )}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <InfoPill label="Current plan" value={activePlan.name} />
                <InfoPill label="Monthly credits" value={`${activePlan.monthlyCredits.toLocaleString("id-ID")} credits`} />
                <InfoPill label="Status" value={activeSubscription?.status || "active"} />
                <InfoPill
                  label="Renewal"
                  value={activeSubscription?.renewalDate ? formatDate(activeSubscription.renewalDate) : "No renewal date"}
                />
              </div>

              <div className="mt-4 rounded-2xl border border-border/70 bg-card/80 p-4">
                <div className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                  {isLaunchMode ? "Launch access" : "Unlocked by current plan"}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {activePlan.unlocks.map((feature) => (
                    <span
                      key={feature}
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
                    >
                      <BadgeCheck className="h-3.5 w-3.5 text-primary" />
                      {feature}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {isLaunchMode ? (
              <div className="rounded-3xl border border-dashed border-emerald-500/30 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-100">
                Launch mode aktif, jadi kartu paket Builder/Studio disembunyikan sementara. Semua fitur sudah dibuka untuk QA dan bug hunting.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {BILLING_PLANS.map((plan) => (
                  <PlanPurchaseCard
                    key={plan.id}
                    plan={plan}
                    activePlanId={activePlanId}
                    hasWorkspace={Boolean(activeWorkspace)}
                    isWorkspaceLoading={isWorkspaceLoading}
                    launchMode={isLaunchMode}
                    onPurchase={(method) => void handlePurchasePlan(plan.id, method)}
                  />
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              Wallet Balance
            </CardTitle>
            <CardDescription>
              Saldo prompt yang dipakai untuk generate, plus top up via Pakasir atau Crypto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end justify-between gap-4 rounded-xl border border-border bg-secondary/40 p-4">
              <div>
                <p className="text-sm text-muted-foreground">Current balance</p>
                <p className="text-3xl font-semibold text-foreground">{formatCurrency(currentBalance)}</p>
              </div>
              <Badge variant={freeCreditsGranted ? "secondary" : "outline"} className="shrink-0">
                {freeCreditsGranted
                  ? `Free credits bulan ini ${formatCurrency(overview?.welcomeBonusAmount || 5000)}`
                  : "Free credits bulan ini belum masuk"}
              </Badge>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <InfoPill label="Minimum top up" value={formatCurrency(topupMinimum)} />
              <InfoPill label="Payment gateway" value="Pakasir + Crypto" />
              <InfoPill label="Free plan credits" value={formatCurrency(overview?.welcomeBonusAmount || 5000)} />
            </div>

            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              Akun Free mendapat 5.000 credits per bulan. Bonus awal 5.000 credits diberikan saat pendaftaran. Setelah itu, top up bisa mulai dari Rp 2.000 (Pakasir) atau minimum crypto {cryptoMinimumLabel}.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Buy Top Up
            </CardTitle>
            <CardDescription>
              Pilih payment method, nominal, lalu checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Payment Method Tabs */}
            <div className="flex gap-2 border-b border-border">
              <button
                onClick={() => setPaymentMethod("pakasir")}
                className={cn(
                  "px-4 py-2 border-b-2 font-medium text-sm transition",
                  paymentMethod === "pakasir"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                💳 Pakasir (QRIS)
              </button>
              <button
                onClick={() => setPaymentMethod("crypto")}
                className={cn(
                  "px-4 py-2 border-b-2 font-medium text-sm transition flex items-center gap-1",
                  paymentMethod === "crypto"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Coins className="h-4 w-4" />
                Crypto (EVM)
              </button>
            </div>

            {/* Amount Selection */}
            <div className="grid grid-cols-2 gap-2">
              {QUICK_AMOUNTS.map((quickAmount) => (
                <Button
                  key={quickAmount}
                  type="button"
                  variant={String(quickAmount) === amount ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAmount(String(quickAmount))}
                >
                  {formatCurrency(quickAmount)}
                </Button>
              ))}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Custom amount</label>
              <Input
                type="number"
                min={TOPUP_MINIMUM_IDR}
                step={1000}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={paymentMethod === "crypto" ? "15800" : "2000"}
              />
              <p className="text-xs text-muted-foreground">
                {paymentMethod === "crypto"
                  ? `Minimum ${cryptoMinimumLabel}`
                  : `Minimum Rp ${topupMinimum.toLocaleString("id-ID")}`}
              </p>
            </div>

            {/* Crypto Chain Selection */}
            {paymentMethod === "crypto" && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Pilih Network</label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={selectedChain === 56 ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedChain(56)}
                  >
                    🟡 BNB Chain
                  </Button>
                  <Button
                    type="button"
                    variant={selectedChain === 8453 ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedChain(8453)}
                  >
                    ⚪ Base (ETH)
                  </Button>
                </div>
              </div>
            )}

            {/* Submit Button */}
            <Button
              className="w-full"
              onClick={paymentMethod === "pakasir" ? handleCreateTopup : handleCreateCryptoTopup}
              disabled={isSubmitting || isCryptoLoading || isLoading}
            >
              {isSubmitting || isCryptoLoading
                ? "Opening checkout..."
                : paymentMethod === "pakasir"
                  ? "Continue to Pakasir"
                  : "Pay with Crypto"}
            </Button>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {message && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span>{message}</span>
              </div>
            )}

            {lastCheckoutUrl && (
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={() => window.open(lastCheckoutUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="h-4 w-4" />
                Open payment link
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Recent top up orders</CardTitle>
            <CardDescription>
              Order yang dibuat ke Pakasir dan Crypto, plus status pembayaran terbarunya.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <EmptyState text="Loading top up orders..." />
            ) : balanceTopUpOrders.length === 0 ? (
              <EmptyState text="Belum ada order top up." />
            ) : (
              <div className="space-y-3">
                {balanceTopUpOrders.map((order) => {
                  const payload = parseBillingOrderPayload(order.payload)
                  const orderPlan = getBillingPlan(payload?.planId)
                  const orderMethod = payload?.purchaseType === "subscription" ? `📦 ${orderPlan.name}` : order.provider === "pakasir" ? "💳 QRIS" : "🪙 Crypto"

                  return (
                    <div key={order.id} className="rounded-xl border border-border bg-card/50 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">{order.reference}</p>
                            <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
                            <Badge variant="outline" className="text-xs">
                              {orderMethod}
                            </Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {formatCurrency(order.amount)}
                          </p>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <p>Created {formatDate(order.createdAt)}</p>
                          {order.paidAt && <p>Paid {formatDate(order.paidAt)}</p>}
                        </div>
                      </div>

                      <Separator className="my-3" />

                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {order.paymentCode && (
                          <span className="rounded-full border border-border px-2 py-1">Code: {order.paymentCode}</span>
                        )}
                        {order.checkoutUrl && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-2 px-2"
                            onClick={() => window.open(order.checkoutUrl || "", "_blank", "noopener,noreferrer")}
                          >
                            <ExternalLink className="h-4 w-4" />
                            Open checkout
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent package purchases</CardTitle>
            <CardDescription>
              Pembelian Builder dan Studio yang mengubah subscription workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <EmptyState text="Loading package purchases..." />
            ) : subscriptionOrders.length === 0 ? (
              <EmptyState text="Belum ada paket yang dibeli." />
            ) : (
              <div className="space-y-3">
                {subscriptionOrders.map((order) => {
                  const payload = parseBillingOrderPayload(order.payload)
                  const plan = getBillingPlan(payload?.planId)

                  return (
                    <div key={order.id} className="rounded-xl border border-border bg-card/50 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">{plan.name}</p>
                            <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {formatCurrency(order.amount)} • {payload?.workspaceId ? "workspace linked" : "workspace unknown"}
                          </p>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <p>Created {formatDate(order.createdAt)}</p>
                          {order.paidAt && <p>Paid {formatDate(order.paidAt)}</p>}
                        </div>
                      </div>

                      <Separator className="my-3" />

                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {plan.unlocks.slice(0, 3).map((feature) => (
                          <span key={feature} className="rounded-full border border-border px-2 py-1">
                            {feature}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-5 w-5" />
              Balance ledger
            </CardTitle>
            <CardDescription>
              Riwayat perubahan saldo untuk bonus awal, credits bulanan, top up, usage, dan refund.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <EmptyState text="Loading balance ledger..." />
            ) : (overview?.billingTransactions.length || 0) === 0 ? (
              <EmptyState text="Belum ada transaksi saldo." />
            ) : (
              <div className="space-y-3">
                {overview?.billingTransactions.map((transaction) => (
                  <div key={transaction.id} className="rounded-xl border border-border bg-card/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-foreground">{transaction.kind.replace(/_/g, " ")}</p>
                          <Badge variant={transaction.direction === "credit" ? "secondary" : "destructive"}>
                            {transaction.direction === "credit" ? "+" : "-"}{formatCurrency(transaction.amount)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {transaction.description || transaction.reference || "Balance update"}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDate(transaction.createdAt)}</span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span className="rounded-full border border-border px-2 py-1">Before {formatCurrency(transaction.balanceBefore)}</span>
                      <span className="rounded-full border border-border px-2 py-1">After {formatCurrency(transaction.balanceAfter)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
      {text}
    </div>
  )
}

function PlanPurchaseCard({
  plan,
  activePlanId,
  hasWorkspace,
  isWorkspaceLoading,
  launchMode,
  onPurchase,
}: {
  plan: (typeof BILLING_PLANS)[number]
  activePlanId: BillingPlanId
  hasWorkspace: boolean
  isWorkspaceLoading: boolean
  launchMode: boolean
  onPurchase: (method: "pakasir" | "crypto") => void
}) {
  const isCurrentPlan = activePlanId === plan.id
  const isFreePlan = plan.id === "free"
  const canPurchase = hasWorkspace && !isWorkspaceLoading && !isFreePlan

  return (
    <div
      className={cn(
        "rounded-3xl border border-border/70 bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30",
        plan.highlighted && "border-primary/30 bg-primary/5 shadow-md",
        isCurrentPlan && "ring-1 ring-primary/30"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
            <Badge variant={plan.highlighted ? "default" : "outline"} className="rounded-full px-2.5 py-1 text-[11px]">
              {plan.badge}
            </Badge>
            {isCurrentPlan && (
              <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px]">
                Current
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{plan.description}</p>
        </div>

        <div className="rounded-2xl border border-border/70 bg-background px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Per month</div>
          <div className="mt-1 text-xl font-semibold text-foreground">{formatCurrency(plan.priceIdr)}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <InfoPill label="Credits" value={`${plan.monthlyCredits.toLocaleString("id-ID")} credits`} />
        <InfoPill label="Tokens limit" value={plan.tokensLimit.toLocaleString("id-ID")} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {plan.features.slice(0, 3).map((feature) => (
          <span key={feature} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
            {feature}
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {plan.unlocks.map((feature) => (
          <span key={feature} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {feature}
          </span>
        ))}
      </div>

      {isFreePlan ? (
        <div className="mt-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {launchMode
            ? "Launch mode aktif, jadi fitur premium sedang dibuka sementara untuk semua user."
            : "Plan ini aktif sebagai baseline. Upgrade ke Builder atau Studio untuk membuka fitur premium."}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          <Button type="button" className="w-full gap-2" disabled={!canPurchase} onClick={() => onPurchase("pakasir")}>
            <Zap className="h-4 w-4" />
            {plan.ctaLabel} via Pakasir
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" className="w-full gap-2" disabled={!canPurchase} onClick={() => onPurchase("crypto")}>
            <Coins className="h-4 w-4" />
            {plan.ctaLabel} via Crypto
            <ArrowRight className="h-4 w-4" />
          </Button>
          {!hasWorkspace && !isWorkspaceLoading && (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Pilih workspace dulu untuk membeli paket.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
